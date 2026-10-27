import { type Context, type JsonValue, Watch } from "@earendil-works/chord";
import { awaitWithContext, BACKGROUND_CONTEXT, withoutAbortSignal } from "@earendil-works/chord/context";
import { type Op, PendingOps, track } from "@earendil-works/chord/delta";
import type { SpanAttributes } from "@earendil-works/pi-telemetry";
import {
	type AnyDocToken,
	addressId,
	checkRecordScope,
	checkRecordVersion,
	materializeDocument,
	resolveAddress,
} from "../documents.ts";
import { ReadOnlySession, SessionFailed, StorageRequestError } from "../errors.ts";
import { idFromNumber } from "../ids.ts";
import { hostTimers, type Timers } from "../timers.ts";
import type {
	CommitChange,
	CommitOptions,
	CommitPersistence,
	CommitPublication,
	ConversationDocFamilyToken,
	ConversationDocToken,
	ConversationId,
	ConversationQuery,
	ConversationRecord,
	Cursor,
	DocumentAddress,
	DocumentCommitChange,
	DocumentId,
	DocumentPoint,
	DocumentQuery,
	DocumentRecord,
	DocumentWatch,
	EntryId,
	EntryQuery,
	EntryRecord,
	Id,
	JsonObject,
	Observation,
	Observer,
	Page,
	ReportInfo,
	RewindableConversationDocFamilyToken,
	RewindableConversationDocToken,
	Seq,
	Session,
	SessionDocFamilyToken,
	SessionDocToken,
	SessionEnd,
	SetTimer,
	Storage,
	StorageWrite,
	StoredDocument,
	SubmissionId,
	SubmissionQuery,
	SubmissionRecord,
	TaskDocFamilyToken,
	TaskDocToken,
	TaskId,
	TaskQuery,
	TaskRecord,
	Tx,
} from "../types.ts";
import {
	type AdoptedDocuments,
	type HeldDocument,
	type LoadedDocument,
	storeHeld,
	Transaction,
	type TransactionHost,
	type TransactionScope,
} from "./transaction.ts";

/**
 * What the Session's own components observe of one commit (`observeCommits()`): a stored commit with its own changes, or
 * a deferred one adopted in memory only (`CommitPersistence`), which changes documents only. Memory is never behind:
 * a later store of held changes is not observed again.
 */
export type ObservedCommit =
	| { readonly kind: "stored"; readonly seq: Seq; readonly changes: readonly CommitChange[] }
	| { readonly kind: "memory"; readonly changes: readonly DocumentCommitChange[] };

/** A held document (`HeldDocument`) as the Session keeps it: pinned in the cache until stored. */
type Hold = HeldDocument & {
	/** When the earliest of its held commits must be stored, on the Session clock. */
	deadline: number;
	readonly unpin: () => void;
};

/** The armed store of held documents: a foreground timer for the earliest deadline, `fired` once its job is queued. */
type HoldTimer = { readonly at: number; disarm: () => void; fired: boolean };

const NO_HOLDS: readonly Hold[] = [];

const NO_OPERATIONS: readonly Op[] = [];

/**
 * Queues a commit's host dispatch as one microtask through `then`: in the same queue as `queueMicrotask()`, which Node
 * wraps in an async resource that costs about twice the memory and three times the time per stored commit.
 */
const SETTLED: Promise<void> = Promise.resolve();

/** The default source of a report: a listener, which never fails what ran it. */
const LISTENER: ReportInfo = { type: "listener_error" };

/** A telemetry adapter that threw on a commit's event, which must not fail the durable commit. */
const TELEMETRY: ReportInfo = { type: "host_error", callback: "telemetry" };

/**
 * Open a Session kernel over one storage backend. `now` is the wall clock for task times; default `Date.now`.
 * `setTimer` arms the timers that evict idle documents; default `setTimeout` (see `HarnessOptions.setTimer`). The first
 * error a Storage method throws fails the Session (`SessionFailed`); see `SessionImpl`.
 */
export function createSession(
	storage: Storage,
	options?: {
		readonly now?: () => number;
		readonly documentRetentionMs?: number;
		readonly setTimer?: SetTimer;
		/** Default `withinMs` of a deferred commit (`CommitPersistence`); default 1,000. */
		readonly persistWithinMs?: number;
	},
): Session {
	const retention = options?.documentRetentionMs;
	const within = options?.persistWithinMs;
	return new SessionImpl(
		storage,
		options?.now,
		retention === undefined ? undefined : () => retention,
		options?.setTimer,
		false,
		() => within,
	);
}

/** Default document retention: ten minutes, as for kept contexts. */
let defaultRetention = 600_000;

/** Internal, for tests: the retention of every Session that keeps the default, as a suite run with eviction at once. */
export function setDefaultDocumentRetention(ms: number): void {
	defaultRetention = ms;
}

/**
 * A retention as given, when it is a number of milliseconds, `0` or more (`Infinity` keeps documents); otherwise the
 * default.
 */
export function documentRetention(ms: number | undefined): number {
	return typeof ms === "number" && ms >= 0 ? ms : defaultRetention;
}

/** Default `withinMs` of a deferred commit, `settings.progress.persistWithinMs`. */
const DEFAULT_PERSIST_WITHIN_MS = 1_000;

/**
 * A deferred commit's default window as given, when it is a number of milliseconds, `0` or more (`Infinity` waits for a
 * reading or writing commit or close); otherwise the default.
 */
export function persistWithin(ms: number | undefined): number {
	return typeof ms === "number" && ms >= 0 ? ms : DEFAULT_PERSIST_WITHIN_MS;
}

/**
 * Session kernel: one mutation line, the loaded document tracker cache, and committed publication.
 *
 * The cache is bounded by use: a document with no watch attached leaves it once it was not read or
 * written for the retention period, and the next access loads it from Storage. Eviction runs as a job on the mutation
 * line, so no transaction ever holds a tracker that leaves.
 *
 * Only committed state is observable. A deferred commit (`CommitPersistence`) is committed in memory first: it is
 * adopted and shown to the Session's own observers, and its changes wait, folded per document and pinned in the cache,
 * for the first commit that reads or writes the document, the document's deadline, a drop of its tracker, or close,
 * which store them. Every commit callback, preparation, Storage settlement, and adoption runs while the line is held. A
 * stored commit is published when Storage adopts it: inside `adopt` its telemetry events and the Session's own
 * observers, one microtask later `subscribeCommits()` listeners, before every wait the commit resolves and every abort
 * it queues, all still on the line. Host listeners and watch listeners have no order.
 *
 * Storage failures are final. Every Storage call goes through one guard: the first error a Storage method throws, other
 * than for a cancelled caller, fails the Session, as does a commit it cannot adopt. That call gets the error; every later
 * call and every Storage call still underway gets `SessionFailed`; close listeners run at once with the error, and the
 * Session then closes itself, Storage included, and `closed` settles. Nothing retries: transient errors are the
 * Storage's to retry. Reopening recovers from what was committed.
 */
export class SessionImpl implements Session {
	readonly #storage: Storage;
	readonly #documents = new Map<string, LoadedDocument>();
	/** Cached documents with no observer attached, by address, oldest use first, with the time of that use. */
	readonly #idleDocuments = new Map<string, number>();
	/** Observers attached per document incarnation (record ID); a cached incarnation with any is never evicted. */
	readonly #attachedDocuments = new Map<DocumentId, number>();
	readonly #clock: () => number;
	readonly #documentRetentionMs: () => number;
	readonly #persistWithinMs: () => number;
	/** Documents with held changes, by incarnation (record ID); each is pinned in the cache until they are stored. */
	readonly #holds = new Map<DocumentId, Hold>();
	#holdTimer: HoldTimer | undefined;
	/** Refuse every commit with writes (`HarnessOptions.readOnly`). */
	readonly #readOnly: boolean;
	readonly #timers: Timers;
	/** The pending eviction: a timer for the oldest idle document, or a line job when the retention is 0. */
	#documentSweep: { readonly at: number; disarm: (() => void) | undefined } | undefined;
	#sweepJobs = 0;
	/** Set once the host declined a background timer: then none is kept, and the end of each commit evicts what expired. */
	#documentTimersUnavailable = false;
	readonly #commitListeners = new Set<(publication: CommitPublication, context: Context) => void>();
	/** The Session's own listeners, such as its scheduler's: they keep memory in step with storage, so a throw fails it. */
	readonly #internalListeners = new Set<(publication: ObservedCommit, context: Context) => void>();
	readonly #closeListeners = new Set<() => void>();
	readonly #host: TransactionHost;
	#tail: Promise<void> = Promise.resolve();
	#closing: Promise<void> | undefined;
	#failure: { readonly error: unknown } | undefined;
	/** Set when close reaches the backend: calls that fail from then on fail because it closes. */
	readonly #failed = Promise.withResolvers<never>();
	readonly #closed = Promise.withResolvers<SessionEnd>();

	get closed(): Promise<SessionEnd> {
		return this.#closed.promise;
	}

	/** Internal: the error that failed the Session, if one did. */
	get failure(): { readonly error: unknown } | undefined {
		return this.#failure;
	}

	/** Internal: rejects with `SessionFailed` the moment the Session fails, before work underway has ended; never resolves. */
	get failed(): Promise<never> {
		return this.#failed.promise;
	}

	constructor(
		storage: Storage,
		now: () => number = Date.now,
		documentRetentionMs: () => number | undefined = () => undefined,
		setTimer?: SetTimer,
		readOnly = false,
		persistWithinMs: () => number | undefined = () => undefined,
	) {
		// Waits race it; none has to.
		this.#failed.promise.catch(() => {});
		this.#readOnly = readOnly;
		this.#storage = new GuardedStorage(storage, this);
		this.#timers = hostTimers(setTimer, (error) => this.report(error, { type: "host_error", callback: "setTimer" }));
		// Cache bookkeeping must never change the outcome of the operation it follows: a clock or a retention setting
		// that throws counts as now, and as the default.
		this.#clock = () => {
			try {
				return now();
			} catch {
				return Date.now();
			}
		};
		this.#documentRetentionMs = () => {
			try {
				return documentRetention(documentRetentionMs());
			} catch {
				return documentRetention(undefined);
			}
		};
		this.#persistWithinMs = () => {
			try {
				return persistWithin(persistWithinMs());
			} catch {
				return persistWithin(undefined);
			}
		};
		this.#host = {
			storage: this.#storage,
			now,
			cached: (id) => {
				const cached = this.#documents.get(id);
				if (cached !== undefined) this.#touchDocument(id);
				return cached;
			},
			load: (definition, addressId, address, context) => this.#loadDocument(definition, addressId, address, context),
			install: (document) => {
				this.#documents.set(document.addressId, document);
				this.#touchDocument(document.addressId);
			},
			evict: (id, recordId) => {
				if (this.#documents.get(id)?.record.id === recordId) this.#dropDocument(id);
			},
			conversationCreated: (tx, record) => this.conversationCreated(tx, record),
		};
	}

	/** The Storage behind the failure guard; every component reads and writes through it. */
	protected get storage(): Storage {
		return this.#storage;
	}

	commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context, options?: CommitOptions): Promise<T> {
		return this.commitWith(change, context, undefined, options);
	}

	/**
	 * Internal: fail the Session with `error`, the first wins, and report it once. Admission ends, and close listeners run
	 * now; they read the error from `failure`. The Storage guard calls this; the Harness also calls it for a throw in its
	 * scheduler's own commits.
	 */
	fail(error: unknown, context?: Context): void {
		if (this.#failure !== undefined) return;
		this.#failure = { error };
		this.#failed.reject(new SessionFailed(error));
		// Seal first, so a report handler that calls back finds the Session failed. Closing runs the close listeners
		// synchronously; a failing backend close is the caller's to see, and here nobody waits.
		this.close(BACKGROUND_CONTEXT).catch(() => {});
		this.report(error, { type: "session_failed" }, context);
	}

	/**
	 * Internal commit exposing the concrete transaction and its internal operations, such as the reserved-ID root
	 * bootstrap and task replacement. `scope` sets the default `tx.createTask()` conversation and the task attributed to
	 * appended entries.
	 */
	commitWith<T>(
		change: (tx: Transaction) => T | Promise<T>,
		context: Context,
		scope?: TransactionScope,
		options?: CommitOptions,
	): Promise<T> {
		let withinMs: number | undefined;
		try {
			this.assertUsable();
			withinMs = this.#deferral(options?.persistence);
		} catch (error) {
			return Promise.reject(error);
		}
		return this.#enqueue(() => this.#runCommit(change, context, scope, withinMs));
	}

	/** How long a commit may stay in memory before it is stored; `undefined` when it is immediate. */
	#deferral(persistence: CommitPersistence | undefined): number | undefined {
		if (persistence?.kind !== "deferred") return undefined;
		const ms = persistence.withinMs;
		if (ms === undefined) return this.#persistWithinMs();
		// Public options: checked here, as the types cannot.
		if (typeof ms !== "number" || !(ms >= 0)) {
			throw new TypeError("CommitPersistence.withinMs must be a number of milliseconds, 0 or more");
		}
		return ms;
	}

	/** Internal: run a read-only job on the mutation line so multi-read derivations observe one committed state. */
	readOnLine<T>(job: () => Promise<T>): Promise<T> {
		try {
			this.assertUsable();
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
		this.assertUsable();
		const definition = token.definition;
		const resolved = resolveAddress(definition, args);
		const context = args[resolved.nextArgument] as Context;
		const cached = this.#documents.get(resolved.id);
		if (cached?.valueVersion === definition.version) this.#touchDocument(resolved.id);
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
	watchDoc(token: AnyDocToken, ...args: readonly unknown[]): Promise<DocumentWatch<JsonObject> | undefined> {
		// Not async, so an attachment costs one async frame, `#attachDocument`'s; a throw here still rejects.
		try {
			this.assertUsable();
			const definition = token.definition;
			const resolved = resolveAddress(definition, args);
			const context = args[resolved.nextArgument] as Context;
			const signal = context.abortSignal;
			return this.#attachDocument(
				definition,
				resolved,
				context,
				(loaded) => {
					const watch = this.#observeDocument(definition, loaded, createWatch, endWatch);
					if (signal !== undefined) watch.observeCancellation(signal);
					return watch;
				},
				cancelWatch,
			);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	observeDoc<T extends JsonObject>(
		token: SessionDocToken<T>,
		observer: Observer<Readonly<T>>,
		context: Context,
	): Promise<Observation<Readonly<T>> | undefined>;
	observeDoc<T extends JsonObject>(
		token: ConversationDocToken<T>,
		conversationId: ConversationId,
		observer: Observer<Readonly<T>>,
		context: Context,
	): Promise<Observation<Readonly<T>> | undefined>;
	observeDoc<T extends JsonObject>(
		token: TaskDocToken<T>,
		taskId: TaskId,
		observer: Observer<Readonly<T>>,
		context: Context,
	): Promise<Observation<Readonly<T>> | undefined>;
	observeDoc<T extends JsonObject, I extends JsonValue>(
		token: SessionDocFamilyToken<T, I>,
		key: string,
		observer: Observer<Readonly<T>>,
		context: Context,
	): Promise<Observation<Readonly<T>> | undefined>;
	observeDoc<T extends JsonObject, I extends JsonValue>(
		token: ConversationDocFamilyToken<T, I>,
		conversationId: ConversationId,
		key: string,
		observer: Observer<Readonly<T>>,
		context: Context,
	): Promise<Observation<Readonly<T>> | undefined>;
	observeDoc<T extends JsonObject, I extends JsonValue>(
		token: TaskDocFamilyToken<T, I>,
		taskId: TaskId,
		key: string,
		observer: Observer<Readonly<T>>,
		context: Context,
	): Promise<Observation<Readonly<T>> | undefined>;
	observeDoc(token: AnyDocToken, ...args: readonly unknown[]): Promise<Observation<Readonly<JsonObject>> | undefined> {
		// Not async, as `watchDoc()`; a throw here still rejects.
		try {
			this.assertUsable();
			const definition = token.definition;
			const resolved = resolveAddress(definition, args);
			const observer = args[resolved.nextArgument] as Observer<Readonly<JsonObject>>;
			const context = args[resolved.nextArgument + 1] as Context;
			return this.#attachDocument(
				definition,
				resolved,
				context,
				(loaded) => {
					const guarded = this.#observeDocument(
						definition,
						loaded,
						(_value, detach, report) => guardObserver(observer, detach, report),
						endGuarded,
					);
					return observation(loaded.tracker.value, guarded);
				},
				detachObservation,
			);
		} catch (error) {
			return Promise.reject(error);
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
		this.assertUsable();
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
						// Last, after the writes at close (`writeAtClose()`), while the trackers are still here. A failed Session
						// writes nothing; a failing store fails it, and the backend still closes.
						let unstored: { readonly error: unknown } | undefined;
						// Only with something to store: otherwise the backend's close begins in this very job.
						if (this.#failure === undefined && this.#holds.size > 0) {
							await this.#storeHolds([...this.#holds.values()], cleanup).catch((error: unknown) => {
								unstored = { error };
							});
						}
						this.#commitListeners.clear();
						this.#internalListeners.clear();
						this.#documents.clear();
						this.#idleDocuments.clear();
						this.#attachedDocuments.clear();
						this.#holds.clear();
						try {
							await this.#storage.close(cleanup);
						} catch (error) {
							// A Storage that cannot close is a failed one; an earlier failure stays the cause.
							if (this.#failure === undefined) {
								this.#failure = { error };
								this.report(error, { type: "session_failed" });
							}
							throw error;
						}
						if (unstored !== undefined) throw unstored.error;
					}),
				)
				.finally(() => {
					const failure = this.#failure;
					this.#closed.resolve(
						failure === undefined ? { reason: "closed" } : { reason: "failed", error: failure.error },
					);
				});
			this.#notifyClose();
		}
		return awaitWithContext(this.#closing, context);
	}

	/** Run the close listeners once, each on its own: one that fails is reported, and the rest still run. */
	#notifyClose(): void {
		this.#documentSweep?.disarm?.();
		this.#documentSweep = undefined;
		this.#holdTimer?.disarm();
		this.#holdTimer = undefined;
		const listeners = [...this.#closeListeners];
		this.#closeListeners.clear();
		for (const listener of listeners) contained(listener, (error) => this.report(error));
	}

	/**
	 * Internal: the Session's failure, and errors of listeners, which never fail what ran them; `info` defaults to a
	 * listener. A plain Session drops them.
	 */
	report(_error: unknown, _info: ReportInfo = LISTENER, _context?: Context): void {}

	/**
	 * Runs inside every transaction that creates or forks a conversation, after the conversation record is staged. A
	 * plain Session stages nothing; a Harness stages its built-in documents.
	 */
	protected conversationCreated(_tx: Transaction, _record: ConversationRecord): Promise<void> {
		return Promise.resolve();
	}

	/**
	 * Internal, for `beforeClose()`: on the line, after every commit admitted before the seal has settled, write what
	 * `writes()` returns then straight to Storage. Nothing is published, since the Session is closing; a failed Session
	 * writes nothing.
	 */
	protected writeAtClose(writes: () => readonly StorageWrite[]): Promise<void> {
		return this.#enqueue(async () => {
			if (this.#failure !== undefined) return;
			const batch = writes();
			if (batch.length > 0) await this.#storage.commit(batch, () => {}, BACKGROUND_CONTEXT);
		});
	}

	/** Runs after close seals admission and before the line closes Storage; must not reject. */
	protected beforeClose(): Promise<void> {
		return Promise.resolve();
	}

	/**
	 * Register a synchronous listener for every stored commit, with exactly what it stored (`CommitPublication`). It runs
	 * one microtask after Storage adopted the commit, on the line, before every wait the commit resolves and every abort
	 * it queues (in no order with watch listeners); it must not block or call Session operations, and a throw is
	 * reported.
	 */
	subscribeCommits(listener: (publication: CommitPublication, context: Context) => void): () => void {
		this.assertUsable();
		this.#commitListeners.add(listener);
		return () => this.#commitListeners.delete(listener);
	}

	/**
	 * Internal: observe every commit as memory adopts it (`ObservedCommit`), for the Session's own components, whose state
	 * follows memory. A throw leaves that state behind, so it fails the Session instead of being reported. For a stored
	 * commit they run inside Storage's `adopt`, so they call no Storage method, run no task code, and contain every host
	 * callback; the waits they resolve and the aborts they queue run after host listeners.
	 */
	observeCommits(listener: (publication: ObservedCommit, context: Context) => void): () => void {
		this.assertUsable();
		this.#internalListeners.add(listener);
		return () => this.#internalListeners.delete(listener);
	}

	/**
	 * Register a listener called synchronously when close begins, also when a failure closes the Session (`failure` is
	 * then set). It must not block or call Session operations; a throw is reported.
	 */
	subscribeClose(listener: () => void): () => void {
		this.assertUsable();
		this.#closeListeners.add(listener);
		return () => this.#closeListeners.delete(listener);
	}

	/** Drop every loaded tracker on the mutation line, held changes stored first; later access cold-loads from Storage. */
	unloadDocuments(): Promise<void> {
		return this.#enqueue(async () => {
			if (this.#failure === undefined) await this.#storeHolds([...this.#holds.values()], BACKGROUND_CONTEXT);
			this.#documents.clear();
			this.#idleDocuments.clear();
		});
	}

	/**
	 * Internal, for tests: how many documents the cache holds, how many are idle, how many incarnations are pinned, how
	 * many sweep jobs were queued on the line so far, and how many documents have held changes.
	 */
	get documentCacheSizes(): {
		readonly cached: number;
		readonly idle: number;
		readonly attached: number;
		readonly sweeps: number;
		readonly held: number;
	} {
		return {
			cached: this.#documents.size,
			idle: this.#idleDocuments.size,
			attached: this.#attachedDocuments.size,
			sweeps: this.#sweepJobs,
			held: this.#holds.size,
		};
	}

	/** Note a use of a cached document: an unattached one becomes the newest idle one, and an eviction is scheduled. */
	#touchDocument(addressId: string): void {
		const cached = this.#documents.get(addressId);
		if (cached === undefined || this.#attachedDocuments.has(cached.record.id)) return;
		const now = this.#clock();
		const since = this.#idleDocuments.get(addressId);
		// A hot document moves to the back at most once per granule, a tenth of the retention up to 1 s: it may then leave
		// up to a granule early, which costs a reload, while a commit-heavy workload skips the reordering.
		if (since !== undefined && now - since < Math.min(1_000, this.#documentRetentionMs() / 10)) return;
		this.#idleDocuments.delete(addressId);
		this.#idleDocuments.set(addressId, now);
		// A pending sweep for the oldest document comes first unless the retention was shortened since; then it moves up.
		if (this.#documentSweep === undefined || this.#documentSweep.at > now + this.#documentRetentionMs()) {
			this.#scheduleDocumentSweep();
		}
	}

	#dropDocument(addressId: string): void {
		this.#documents.delete(addressId);
		this.#idleDocuments.delete(addressId);
	}

	/**
	 * Schedule the eviction of the oldest idle document: on the line at once when the retention is 0, otherwise when it
	 * expires, by a background timer (`HarnessOptions.setTimer`), which never keeps the process alive. Where the host
	 * declines it, as the default does in Cloudflare Workers, none is kept: the end of each commit evicts what expired.
	 */
	#scheduleDocumentSweep(): void {
		if (this.#closing !== undefined) return;
		const oldest = this.#idleDocuments.values().next();
		if (oldest.done === true) return;
		const at = oldest.value + this.#documentRetentionMs();
		if (this.#documentSweep !== undefined && this.#documentSweep.at <= at) return;
		this.#documentSweep?.disarm?.();
		// The pending sweep stays set until its job runs, so touches while the line is busy queue no more.
		const sweep: { readonly at: number; disarm: (() => void) | undefined } = { at, disarm: undefined };
		const run = (): void => {
			this.#sweepJobs++;
			this.#enqueue(async () => {
				if (this.#documentSweep === sweep) this.#documentSweep = undefined;
				if (this.#closing === undefined) this.#sweepDocuments();
			}).catch(() => {});
		};
		const delay = at - this.#clock();
		this.#documentSweep = sweep;
		if (delay <= 0) {
			queueMicrotask(run);
			return;
		}
		if (this.#documentTimersUnavailable) {
			this.#documentSweep = undefined;
			return;
		}
		// A timer that fires early sweeps nothing and arms the next one.
		const disarm = this.#timers.background(run, delay);
		if (disarm === undefined) {
			this.#documentTimersUnavailable = true;
			this.#documentSweep = undefined;
			return;
		}
		sweep.disarm = disarm;
	}

	/** On the line: evict the idle documents whose retention passed, oldest first, then schedule the next eviction. */
	#sweepDocuments(): void {
		const expired = this.#clock() - this.#documentRetentionMs();
		for (const [addressId, since] of this.#idleDocuments) {
			if (since > expired) break;
			this.#dropDocument(addressId);
		}
		this.#scheduleDocumentSweep();
	}

	/** Pin a cached incarnation for one observer; the returned release unpins it once, idle again after the last. */
	#pinDocument(addressId: string, recordId: DocumentId): () => void {
		this.#attachedDocuments.set(recordId, (this.#attachedDocuments.get(recordId) ?? 0) + 1);
		this.#idleDocuments.delete(addressId);
		let pinned = true;
		return () => {
			if (!pinned) return;
			pinned = false;
			const count = (this.#attachedDocuments.get(recordId) ?? 1) - 1;
			if (count > 0) {
				this.#attachedDocuments.set(recordId, count);
				return;
			}
			this.#attachedDocuments.delete(recordId);
			if (this.#documents.get(addressId)?.record.id === recordId) this.#touchDocument(addressId);
		};
	}

	async #runCommit<T>(
		change: (tx: Transaction) => T | Promise<T>,
		context: Context,
		scope: TransactionScope | undefined,
		withinMs: number | undefined,
	): Promise<T> {
		this.#assertHealthy();
		context.abortSignal?.throwIfAborted();
		const tx = new Transaction(this.#host, context, scope);
		let result: T;
		try {
			result = await change(tx);
			// A callback that caught a failed read must not commit, nor succeed as if it had.
			this.#assertHealthy();
		} catch (error) {
			await tx.settleFailure();
			this.#sweepDocuments();
			throw error;
		}
		let writes: readonly StorageWrite[];
		try {
			writes = await tx.settleSuccess();
		} catch (error) {
			// Settlement aborted every change already.
			this.#sweepDocuments();
			throw error;
		}
		if (writes.length === 0) {
			tx.discard();
			this.#sweepDocuments();
			return result;
		}
		if (this.#readOnly) {
			// Refused before Storage: the Session stays healthy, and the caller sees why.
			tx.discard();
			this.#sweepDocuments();
			throw new ReadOnlySession("a commit with writes");
		}
		if (withinMs !== undefined) {
			const held = tx.holdable();
			if (held !== undefined) {
				this.#hold(tx, held, withinMs, context);
				this.#sweepDocuments();
				return result;
			}
		}
		// The last step before Storage: held changes leave their queue only once nothing but Storage can fail.
		const taken = this.#holds.size === 0 ? NO_HOLDS : tx.takeHeld((id) => this.#holds.get(id));
		// Storage adopts the batch synchronously once it is durable, before its next commit, and the commit is published in
		// the same step, so every view changes with memory. A throw here would reach Storage, so the callback keeps its own
		// error, and the first error of an own observer.
		let adoption:
			| { readonly documents: AdoptedDocuments; readonly failure?: { readonly error: unknown } }
			| { readonly error: unknown }
			| undefined;
		const adopt = (committed: Seq): void => {
			let documents: AdoptedDocuments;
			try {
				documents = tx.adopt(committed);
			} catch (error) {
				adoption = { error };
				return;
			}
			const failure = this.#publish(committed, writes, documents, context);
			adoption = failure === undefined ? { documents } : { documents, failure };
		};
		try {
			// Once admitted, caller cancellation does not interrupt Storage settlement.
			await this.#storage.commit(writes, adopt, withoutAbortSignal(context));
		} catch (error) {
			// The guard has failed the Session with the storage error. A rejection after adoption leaves nothing staged to
			// discard, and the commit, durable, stays published; an own observer's error that would have failed the Session
			// is still reported.
			if (adoption === undefined) tx.discard();
			else if ("documents" in adoption && adoption.failure !== undefined) {
				this.report(adoption.failure.error, LISTENER, context);
			}
			throw error;
		}
		if (adoption === undefined) {
			const error = new Error("Storage committed without adopting the batch");
			this.fail(error);
			throw error;
		}
		if ("error" in adoption) {
			// Storage already committed; a failed adoption leaves memory behind durable state.
			this.fail(adoption.error);
			throw adoption.error;
		}
		if (taken.length > 0) this.#release(taken);
		for (const document of adoption.documents.stored) this.#touchDocument(addressId(document.record));
		// The commit is durable and published, so it stands; memory behind an own observer's state fails the Session.
		if (adoption.failure !== undefined) this.fail(adoption.failure.error, context);
		this.#sweepDocuments();
		return result;
	}

	/**
	 * Hold a deferred commit (`Transaction.holdable()`): adopt it in memory, queue its changes per document, pinned, by
	 * the earliest deadline of the document's held commits, and show it to the Session's own observers.
	 */
	#hold(
		tx: Transaction,
		held: NonNullable<ReturnType<Transaction["holdable"]>>,
		withinMs: number,
		context: Context,
	): void {
		const documents = tx.adoptHeld();
		const deadline = this.#clock() + withinMs;
		for (const { loaded, ops, base } of held) {
			const id = loaded.record.id;
			let hold = this.#holds.get(id);
			if (hold === undefined) {
				const unpin = this.#pinDocument(loaded.addressId, id);
				hold = { loaded, pending: new PendingOps(), base: false, deadline, unpin };
				this.#holds.set(id, hold);
			}
			hold.pending.push(ops);
			if (base) hold.base = true;
			if (deadline < hold.deadline) hold.deadline = deadline;
		}
		this.#armHoldTimer();
		const publication: ObservedCommit = { kind: "memory", changes: documents };
		for (const listener of [...this.#internalListeners]) {
			// Our own observers are synchronous.
			try {
				listener(publication, context);
			} catch (error) {
				this.fail(error, context);
			}
		}
	}

	/**
	 * Store the held changes of `holds` in one storage transaction, on the line. Memory already has them, so only
	 * `subscribeCommits()` listeners see it, published as Storage adopts it. A failure fails the Session, as every Storage
	 * failure does.
	 */
	async #storeHolds(holds: readonly Hold[], context: Context): Promise<void> {
		if (holds.length === 0) return;
		const writes: Extract<StorageWrite, { readonly type: "document.change" }>[] = [];
		const changes: DocumentCommitChange[] = [];
		for (const hold of holds) {
			const { record, tracker, valueVersion: version } = hold.loaded;
			const value = tracker.value;
			const stored = storeHeld(hold, NO_OPERATIONS, value, version);
			writes.push({ type: "document.change", id: record.id, content: stored.content });
			// Held documents are conversation documents.
			const conversationId = record.scope.kind === "conversation" ? record.scope.conversationId : undefined;
			changes.push({ type: "document", record, conversationId, version, value, ops: stored.ops });
		}
		let adopted = false;
		const adopt = (seq: Seq): void => {
			adopted = true;
			for (const [index, hold] of holds.entries()) {
				if (writes[index]!.content.kind === "base") hold.loaded.deltasSinceBase = 0;
				else hold.loaded.deltasSinceBase++;
			}
			if (this.#commitListeners.size > 0) this.#notifyHosts({ seq, changes }, context);
		};
		await this.#storage.commit(writes, adopt, withoutAbortSignal(context));
		if (!adopted) {
			const error = new Error("Storage committed without adopting the batch");
			this.fail(error);
			throw error;
		}
		this.#release(holds);
	}

	/** After their store: forget `holds`, unpin their documents, and move the timer to the next deadline. */
	#release(holds: readonly Hold[]): void {
		for (const hold of holds) {
			this.#holds.delete(hold.loaded.record.id);
			hold.unpin();
		}
		this.#armHoldTimer();
	}

	/**
	 * Keep a foreground timer (Workers refuse background ones) for the earliest deadline of the held documents. When it
	 * fires, every held document is stored, in one storage transaction: a deadline is the latest time, and the others
	 * cost little more in the same transaction. Once fired, it stays until its job ran.
	 */
	#armHoldTimer(): void {
		if (this.#closing !== undefined) return;
		let at = Infinity;
		for (const hold of this.#holds.values()) if (hold.deadline < at) at = hold.deadline;
		const armed = this.#holdTimer;
		if (armed !== undefined && (armed.fired || armed.at === at)) return;
		armed?.disarm();
		this.#holdTimer = undefined;
		if (at === Infinity) return;
		const timer: HoldTimer = { at, disarm: () => {}, fired: false };
		const run = (): void => {
			timer.fired = true;
			this.#enqueue(async () => {
				if (this.#holdTimer === timer) this.#holdTimer = undefined;
				// Close stores what is held itself.
				if (this.#closing !== undefined || this.#failure !== undefined) return;
				await this.#storeHolds([...this.#holds.values()], BACKGROUND_CONTEXT);
			}).catch(() => {});
		};
		this.#holdTimer = timer;
		timer.disarm = this.#timers.foreground(run, Math.max(0, at - this.#clock()));
	}

	/**
	 * Inside `adopt`: publish a stored commit. Its telemetry events first, then the dispatch to `subscribeCommits()`
	 * listeners, queued before the waits and aborts the observers wake, then the Session's own observers. Never throws:
	 * returns the first error of an own observer, which fails the Session once `Storage.commit()` returned.
	 */
	#publish(
		seq: Seq,
		writes: readonly StorageWrite[],
		documents: AdoptedDocuments,
		context: Context,
	): { readonly error: unknown } | undefined {
		const changes: CommitChange[] | undefined =
			this.#commitListeners.size > 0 || this.#internalListeners.size > 0 ? [] : undefined;
		for (const write of writes) {
			switch (write.type) {
				case "entry":
					this.#event("pi.durable.entry", { "entry.id": write.value.id, "entry.kind": write.value.kind }, context);
					changes?.push(write);
					break;
				case "submission":
					if (write.value.status === "done" || write.value.status === "unanswered") {
						this.#event(
							"pi.durable.submission",
							{
								"submission.id": write.value.id,
								status: write.value.status,
								"answer.entry_id": write.value.answer,
							},
							context,
						);
					}
					changes?.push(write);
					break;
				case "conversation":
				case "task":
					changes?.push(write);
			}
		}
		if (changes === undefined) return undefined;
		const tables = changes.length;
		for (const document of documents.observed) changes.push(document);
		const observed: ObservedCommit = { kind: "stored", seq, changes };
		if (this.#commitListeners.size > 0) {
			// One publication for both, unless the commit also stored held changes, which only host listeners get.
			const stored: CommitPublication =
				documents.stored === documents.observed
					? observed
					: { seq, changes: [...changes.slice(0, tables), ...documents.stored] };
			this.#notifyHosts(stored, context);
		}
		// The commit is durable: a failing observer neither fails the commit nor skips the others.
		let failure: { readonly error: unknown } | undefined;
		for (const listener of [...this.#internalListeners]) {
			// Our own observers are synchronous.
			try {
				listener(observed, context);
			} catch (error) {
				failure ??= { error };
			}
		}
		return failure;
	}

	/** Inside `adopt`: record a commit's telemetry event. A throwing adapter is reported, as `adopt` must not throw. */
	#event(name: string, attributes: SpanAttributes, context: Context): void {
		try {
			context.telemetry.addEvent(name, attributes);
		} catch (error) {
			this.report(error, TELEMETRY, context);
		}
	}

	/**
	 * Inside `adopt`: call the `subscribeCommits()` listeners with `publication` one microtask from now, outside the
	 * storage's synchronous step and, queued before the Session's own observers run, before the waits they resolve and
	 * the aborts they queue.
	 * The listeners are those registered when it runs; a throw is reported.
	 */
	#notifyHosts(publication: CommitPublication, context: Context): void {
		void SETTLED.then(() => {
			for (const listener of [...this.#commitListeners]) {
				contained(
					() => listener(publication, context),
					(error) => this.report(error, LISTENER, context),
				);
			}
		});
	}

	/**
	 * On the line, as one job: load the document at `resolved` and `attach` to it, so the attachment sees every commit
	 * after the value it starts from; `undefined` when absent. Cancelling `context` meanwhile rejects, after `cancel`
	 * undid an attachment made.
	 */
	async #attachDocument<A extends object>(
		definition: AnyDocToken["definition"],
		resolved: { readonly id: string; readonly address: DocumentAddress },
		context: Context,
		attach: (loaded: LoadedDocument) => A,
		cancel: (attached: A) => void,
	): Promise<A | undefined> {
		const signal = context.abortSignal;
		let cancelled = signal?.aborted ?? false;
		const markCancelled = (): void => {
			cancelled = true;
		};
		signal?.addEventListener("abort", markCancelled, { once: true });
		try {
			const attached = await this.#enqueue(async () => {
				this.#assertHealthy();
				if (cancelled) throw cancellationError(signal!);
				const loaded = await this.#loadDocument(definition, resolved.id, resolved.address, context);
				if (cancelled) throw cancellationError(signal!);
				return loaded === undefined ? undefined : attach(loaded);
			});
			if (attached === undefined) return undefined;
			if (cancelled) {
				cancel(attached);
				throw cancellationError(signal!);
			}
			return attached;
		} finally {
			signal?.removeEventListener("abort", markCancelled);
		}
	}

	/**
	 * Follow the address of the incarnation `loaded`, after checking the definition, with the observer `create` makes
	 * from its value, the idempotent detach, and the report of a listener error; returns that observer. It gets each
	 * committed change there, a retirement as a `retired` change with the last value it was given and no ops (a change
	 * in the retiring commit is not published), and a later incarnation as a root replacement. When the commit makes the
	 * owner task of a task document terminal, no later commit can change the address: after its changes the commit
	 * subscription and the pin go, and `ownerEnded` tells the observer, which stays subscribed to the Session's close
	 * until it ends (its detach drops that). `end` gets the Session's close. The current incarnation is pinned in the
	 * cache. The detach runs before `end`; once it ran, nothing more of the commit underway reaches the observer or pins
	 * anything for it. `create` and `ownerEnded` are module functions where they can be, so a watch keeps no closure of
	 * its caller.
	 */
	#observeDocument<O extends Observer<Readonly<JsonObject>>>(
		definition: AnyDocToken["definition"],
		loaded: LoadedDocument,
		create: (value: Readonly<JsonObject>, detach: () => void, report: (error: unknown) => void) => O,
		ownerEnded: (observer: O) => void,
	): O {
		checkRecordScope(definition, loaded.record);
		checkRecordVersion(definition, loaded.record, loaded.storedVersion);
		// The closures below keep only the address, as the cache's ID and first record, which the cache shares while the
		// document is cached: `loaded` holds its incarnation's tracker, which a retirement frees.
		const addressId = loaded.addressId;
		const address: DocumentAddress = loaded.record;
		let incarnation: DocumentId | undefined = loaded.record.id;
		// The value of the incarnation followed; none while the address is absent, so the Session keeps no retired value.
		let value: Readonly<JsonObject> | undefined = loaded.tracker.value;
		// The definition version the observer's value has: a change of another version replaces it whole.
		let version = loaded.valueVersion;
		// The incarnation observed stays cached; once it retires or the observer detaches, it is idle again.
		let unpin = this.#pinDocument(addressId, incarnation);
		let unsubscribeCommit = (): void => {};
		let unsubscribeClose = (): void => {};
		let attached = true;
		const detach = (): void => {
			if (!attached) return;
			attached = false;
			unsubscribeCommit();
			unsubscribeClose();
			unpin();
		};
		const observer = create(loaded.tracker.value, detach, (error) => this.report(error));
		unsubscribeCommit = this.observeCommits((publication, context) => {
			// Listeners run from a copy of the set: another observer's call may have detached this one.
			if (!attached) return;
			let ownerEnds = false;
			for (const change of publication.changes) {
				if (change.type === "task") {
					const scope = address.scope;
					if (
						scope.kind === "task" &&
						change.value.id === scope.taskId &&
						change.value.state.status === "terminal"
					) {
						ownerEnds = true;
					}
					continue;
				}
				// The incarnation followed is at the address by definition; only another record needs the address compared.
				if (change.type !== "document") continue;
				if (change.record.id !== incarnation && !atAddress(change.record, address)) continue;
				if (change.value === null) {
					if (change.record.id !== incarnation) continue;
					// Set with every incarnation.
					const last = value!;
					incarnation = undefined;
					value = undefined;
					unpin();
					observer.advance({ value: last, ops: NO_OPERATIONS, retired: true }, context);
				} else if (change.record.id !== incarnation || change.version !== version) {
					// A new incarnation at the address, or a value of another definition version, whose shape the observer's
					// value does not have: shown whole.
					if (change.record.id !== incarnation) {
						incarnation = change.record.id;
						unpin();
						unpin = this.#pinDocument(addressId, incarnation);
					}
					version = change.version!;
					value = change.value;
					observer.advance({ value, ops: [["r", value]], retired: false }, context);
				} else {
					// A migration-only base changes nothing for an observer of the new version.
					if (change.ops.length === 0) continue;
					value = change.value;
					observer.advance({ value, ops: change.ops, retired: false }, context);
				}
				// The observer may detach in its call, or throw and be detached: the rest of the commit is not its.
				if (!attached) return;
			}
			if (!ownerEnds) return;
			unsubscribeCommit();
			unpin();
			ownerEnded(observer);
		});
		unsubscribeClose = this.subscribeClose(() => {
			detach();
			observer.end(this.#failure);
		});
		return observer;
	}

	async #loadDocument(
		definition: AnyDocToken["definition"],
		addressId: string,
		address: DocumentAddress,
		context: Context,
	): Promise<LoadedDocument | undefined> {
		const cached = this.#documents.get(addressId);
		// A tracker serves only tokens of the version its value was materialized for; others reload from Storage.
		if (cached?.valueVersion === definition.version) {
			this.#touchDocument(addressId);
			return cached;
		}
		if (cached !== undefined) {
			// The reload must find what memory holds: held changes are stored before their tracker goes.
			const hold = this.#holds.get(cached.record.id);
			if (hold !== undefined) await this.#storeHolds([hold], context);
			this.#dropDocument(addressId);
		}
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
		this.#touchDocument(addressId);
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

	/** Internal: throw `SessionFailed` when failed, else an error when closing. */
	assertUsable(): void {
		this.#assertHealthy();
		if (this.#closing !== undefined) throw new Error("Session is closed");
	}

	#assertHealthy(): void {
		if (this.#failure !== undefined) throw new SessionFailed(this.#failure.error);
	}
}

/**
 * Run a host callback that must not fail its caller: a throw, or a promise it returns that rejects, goes to `onError`,
 * which is not awaited.
 */
export function contained(callback: () => unknown, onError: (error: unknown) => void): void {
	try {
		const result = callback();
		// Any thenable, also a promise from another realm; `Promise.resolve` adopts it with handlers of its own.
		if (typeof (result as { then?: unknown } | null)?.then === "function") Promise.resolve(result).catch(onError);
	} catch (error) {
		onError(error);
	}
}

/**
 * `observer`, a host's, behind the rule for observers that run inside Storage's `adopt`: one that throws is reported
 * through `report`, detached, and ended with the error, so the throw never reaches `adopt`; nothing reaches it after
 * its detach or end, and from then on the guard references neither it nor its source. `detach` is the source's; the
 * returned `detach()` is the observation's.
 */
export function guardObserver<T>(
	observer: Observer<T>,
	detach: () => void,
	report: (error: unknown) => void,
): Observer<T> & { detach(): void } {
	type Attached = {
		readonly observer: Observer<T>;
		readonly detach: () => void;
		readonly report: (error: unknown) => void;
	};
	let attached: Attached | undefined = { observer, detach, report };
	/** Detach from the source once, and hand back what it was attached with. */
	const release = (): Attached | undefined => {
		const released = attached;
		attached = undefined;
		released?.detach();
		return released;
	};
	return {
		advance: (change, context) => {
			const current = attached;
			if (current === undefined) return;
			try {
				current.observer.advance(change, context);
			} catch (error) {
				current.report(error);
				if (release() !== undefined) contained(() => current.observer.end({ error }), current.report);
			}
		},
		end: (failure) => {
			const ending = release();
			if (ending !== undefined) contained(() => ending.observer.end(failure), ending.report);
		},
		detach: () => {
			release();
		},
	};
}

/**
 * The `Observation` of a guarded observer attached at `value`. Built outside the attaching closure, so a detached
 * observation keeps nothing but `value` and the spent guard alive.
 */
export function observation<T>(value: T, guarded: { detach(): void }): Observation<T> {
	return { value, detach: () => guarded.detach() };
}

/** A document watch over its source's detach and report. */
function createWatch(
	value: Readonly<JsonObject>,
	detach: () => void,
	report: (error: unknown) => void,
): Watch<Readonly<JsonObject>> {
	return new Watch<Readonly<JsonObject>>(value, detach, report);
}

/** Undo a watch attached while its acquisition was cancelled. */
function cancelWatch(watch: Watch<Readonly<JsonObject>>): void {
	watch.cancel();
}

/** Undo an observation attached while its attachment was cancelled. */
function detachObservation(attached: Observation<Readonly<JsonObject>>): void {
	attached.detach();
}

/** A task document's watch delivers the retirement that ends its task, then ends. */
function endWatch(watch: Watch<Readonly<JsonObject>>): void {
	watch.endAfterDelivery();
}

/** A task document's observer ends right after the retirement that ends its task. */
function endGuarded(guarded: Observer<Readonly<JsonObject>>): void {
	guarded.end(undefined);
}

/** Whether `record` is an incarnation at `address`. */
function atAddress(record: DocumentRecord, address: DocumentAddress): boolean {
	if (record.kind !== address.kind || record.key !== address.key) return false;
	switch (record.scope.kind) {
		case "session":
			return address.scope.kind === "session";
		case "conversation":
			return address.scope.kind === "conversation" && address.scope.conversationId === record.scope.conversationId;
		case "task":
			return address.scope.kind === "task" && address.scope.taskId === record.scope.taskId;
	}
}

function cancellationError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

/** What the guard needs of its Session: the failure so far, and how to fail it. */
type FailureLatch = {
	readonly failure: { readonly error: unknown } | undefined;
	fail(error: unknown): void;
};

/**
 * The Session's Storage behind its failure guard; every component of the Session reads and writes through it. Before a
 * call, a failed Session gets `SessionFailed` without reaching the backend. A call that throws fails the Session and
 * rethrows the backend's error, unless it is a `StorageRequestError` or a read whose caller's context was aborted:
 * neither says the Storage is broken.
 * `close()` always reaches the backend, so a failed Session still closes it.
 */
class GuardedStorage implements Storage {
	readonly #storage: Storage;
	readonly #latch: FailureLatch;
	/** Backend calls underway, also those off the Session line, which close waits for before it closes the backend. */
	readonly #underway = new Set<Promise<unknown>>();
	#closing = false;

	constructor(storage: Storage, latch: FailureLatch) {
		this.#storage = storage;
		this.#latch = latch;
	}

	/** Never exempt, whatever it throws: once admitted, whether a failed batch committed is unknown. */
	commit(writes: readonly StorageWrite[], adopt: (seq: Seq) => void, context: Context): Promise<Seq> {
		return this.#call(undefined, () => this.#storage.commit(writes, adopt, context));
	}

	mintId<I extends Id<string>>(): Promise<I> {
		return this.#call(undefined, () => this.#storage.mintId<I>());
	}

	conversation(id: ConversationId, context: Context): Promise<ConversationRecord | undefined> {
		return this.#call(context, () => this.#storage.conversation(id, context));
	}

	scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<ConversationRecord, Cursor>> {
		return this.#call(context, () => this.#storage.scanConversations(query, limit, cursor, context));
	}

	entry(id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	entry(
		conversationId: ConversationId,
		id: EntryId,
		context: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	entry(
		first: EntryId | ConversationId,
		second: EntryId | Context,
		third?: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
		if (third === undefined) {
			const context = second as Context;
			return this.#call(context, () => this.#storage.entry(first as EntryId, context));
		}
		return this.#call(third, () => this.#storage.entry(first as ConversationId, second as EntryId, third));
	}

	findLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		context: Context,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
		return this.#call(context, () => this.#storage.findLatestHeadMarker(conversationId, atOrBeforeEntryId, context));
	}

	scanEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		return this.#call(context, () => this.#storage.scanEntries(query, limit, cursor, context));
	}

	task(id: TaskId, context: Context): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined> {
		return this.#call(context, () => this.#storage.task(id, context));
	}

	scanTasks(
		query: TaskQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<TaskRecord<JsonValue, JsonValue, JsonValue>, Cursor>> {
		return this.#call(context, () => this.#storage.scanTasks(query, limit, cursor, context));
	}

	submission(id: SubmissionId, context: Context): Promise<SubmissionRecord | undefined> {
		return this.#call(context, () => this.#storage.submission(id, context));
	}

	scanSubmissions(
		query: SubmissionQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<SubmissionRecord, Cursor>> {
		return this.#call(context, () => this.#storage.scanSubmissions(query, limit, cursor, context));
	}

	submissionByRequest(
		conversationId: ConversationId,
		requestId: string,
		context: Context,
	): Promise<SubmissionRecord | undefined> {
		return this.#call(context, () => this.#storage.submissionByRequest(conversationId, requestId, context));
	}

	findDocument(address: DocumentAddress, at: DocumentPoint, context: Context): Promise<DocumentRecord | undefined> {
		return this.#call(context, () => this.#storage.findDocument(address, at, context));
	}

	document(id: DocumentId, at: DocumentPoint, context: Context): Promise<StoredDocument | undefined> {
		return this.#call(context, () => this.#storage.document(id, at, context));
	}

	scanDocuments(
		query: DocumentQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<DocumentRecord, Cursor>> {
		return this.#call(context, () => this.#storage.scanDocuments(query, limit, cursor, context));
	}

	/**
	 * Close the backend once every call underway has settled, so none outlives it or fails after `closed` settles. New
	 * calls are refused from here on: a paged read must not start its next page while the backend closes.
	 */
	async close(context: Context): Promise<void> {
		this.#closing = true;
		await Promise.allSettled([...this.#underway]);
		return this.#storage.close(context);
	}

	/**
	 * Run one backend call under the guard. `read` is a read's context; `commit()` and `mintId()` pass none, so nothing
	 * exempts their errors: once a batch is admitted, whether it committed is unknown. A call still underway when another
	 * fails the Session ends with `SessionFailed` too, whatever it returns: nothing it read or wrote is used.
	 */
	async #call<T>(read: Context | undefined, run: () => Promise<T>): Promise<T> {
		this.#assertHealthy();
		if (this.#closing) throw new Error("Session is closed");
		let result: T;
		// An async wrapper, so a backend that throws synchronously is guarded too.
		const call = (async () => run())();
		this.#underway.add(call);
		try {
			result = await call;
		} catch (error) {
			this.#assertHealthy();
			// An invalid read, or one its caller cancelled, says nothing about the Storage; it fails that call only.
			const exempt =
				read !== undefined && (error instanceof StorageRequestError || read.abortSignal?.aborted === true);
			if (!exempt) this.#latch.fail(error);
			throw error;
		} finally {
			this.#underway.delete(call);
		}
		this.#assertHealthy();
		return result;
	}

	#assertHealthy(): void {
		const failure = this.#latch.failure;
		if (failure !== undefined) throw new SessionFailed(failure.error);
	}
}
