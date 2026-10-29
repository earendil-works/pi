// Transactions (§9, R12, R13): drafts of an object's documents, prepared and adopted in one batch, with Chord's own
// staged changes (job runs, §15), fenced by the token they run under; they run on the object's line (`line.ts`).

import { type Context, withoutAbortSignal } from "../../context/index.ts";
import { type Change, type Draft, type Prepared, type Tracker, track } from "../../delta/index.ts";
import { ChordError } from "../data/index.ts";
import { asChordError } from "../data/internal.ts";
import type { JobHandle, Outcome, Run, StartOptions } from "../jobs/index.ts";
import type { Job } from "../jobs/internal.ts";
import type { Columns, PutRowOf, RowOf } from "../store/columns.ts";
import type { Condition, SetOf } from "../store/expression.ts";
import type { ColumnRefs, Query } from "../store/query.ts";
import { refusalOf } from "../store/refusal.ts";
import type { StagedWrite } from "../store/step.ts";
import type { ChordStore } from "../store/store.ts";
import type { KeyOf } from "../store/table.ts";
import { TableChanges } from "../store/table-changes.ts";
import { type Page, type PageOptions, ROWS_PAGE, type Table, TableHandle } from "../store/table-handle.ts";
import type { CommitPersistence, JsonObject } from "./definition.ts";
import type { Documents } from "./documents.ts";
import type { SealToken } from "./fence.ts";
import type { Keyed, KeyedHandle, Singleton, SingletonHandle } from "./handles.ts";
import type { KeyedSlot } from "./keyed-slot.ts";
import { checkReadable, type FoundDocument, type Stored, type StoredChange } from "./persistence.ts";
import type { DocumentSlot, PersistedSlot, SingletonSlot } from "./slot.ts";

/** What `self.tx` gives its callback. Inside it: only `await tx.*`, no other `self.tx`, no calls to other objects. */
export interface Tx {
	/** The document's draft: the same one for the same document within one transaction. */
	draft<T extends JsonObject>(handle: SingletonHandle<T>): Promise<Draft<T>>;
	draft<T extends JsonObject>(handle: KeyedHandle<T>, key: string): Promise<Draft<T>>;
	/** Retires the document when the transaction commits (its address reads `initial()` again); a no-op when it is absent. */
	retire(handle: SingletonHandle<JsonObject>): Promise<void>;
	retire(handle: KeyedHandle<JsonObject>, key: string): Promise<void>;
	/**
	 * Starts a run of `job`, one of this object's jobs, with this transaction's other writes (§15): both commit or
	 * neither. Returns its `Run` at once; a discarded transaction's `Run` rejects `released` from `outcome`. A key of an
	 * unsettled run (one started earlier in this transaction too) returns that run.
	 */
	start<A, R, S>(job: JobHandle<A, R, S>, args: A, options?: StartOptions): Run<Outcome<A, R, S>>;
	/** The row with `key` as this transaction leaves it (its own `put`, `update`, `delete` overlaid; W10). */
	get<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		key: KeyOf<C, K>,
	): Promise<RowOf<C> | undefined>;
	/** A page of committed rows, stable for the transaction (without its own writes). */
	page<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		q: Query<C, K>,
		limit: number,
		options?: PageOptions,
	): Promise<Page<RowOf<C>>>;
	/** Every committed row of `q`, as `page`. */
	rows<C extends Columns, K extends readonly string[]>(table: Table<C, K>, q: Query<C, K>): AsyncIterable<RowOf<C>>;
	/** Writes `row` when the transaction commits (an upsert: the whole row replaced). */
	put<C extends Columns, K extends readonly string[]>(table: Table<C, K>, row: PutRowOf<C>): void;
	/** Changes the row with `key` when the transaction commits; an absent key changes nothing. */
	update<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		key: KeyOf<C, K>,
		set: SetOf<C, K> | ((row: ColumnRefs<C>) => SetOf<C, K>),
	): void;
	/** Deletes the row with `key` when the transaction commits. */
	delete<C extends Columns, K extends readonly string[]>(table: Table<C, K>, key: KeyOf<C, K>): void;
	/** Changes every row matching `where` when the transaction commits (one statement, its count recorded). */
	updateWhere<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		where: (row: ColumnRefs<C>) => Condition,
		set: SetOf<C, K> | ((row: ColumnRefs<C>) => SetOf<C, K>),
	): void;
	/** Deletes every row matching `where` when the transaction commits. */
	deleteWhere<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		where: (row: ColumnRefs<C>) => Condition,
	): void;
}

/**
 * Chord's own changes staged in a transaction (a job's run records): adopted in its commit step with the documents,
 * then told how the transaction ended, once the owner's line is free.
 */
export interface Staged {
	/** Adopts the changes, inside the commit's batch. */
	adopt(): void;
	/** The transaction committed: the actions after the commit (a run starts, waiters settle). */
	committed(): void;
	/** The transaction was discarded: nothing was adopted. */
	discarded(): void;
}

/**
 * What one transaction does with one document: a draft, a retirement, or both (retired, then drafted anew); `found`
 * is what is stored of a cold persisted document it retires without loading (R13).
 */
type Entry = {
	readonly slot: DocumentSlot;
	readonly key: string;
	draft: { readonly tracker: Tracker<JsonObject>; readonly change: Change<JsonObject> } | undefined;
	retire: boolean;
	found: Stored | undefined;
};

const IMMEDIATE: CommitPersistence = { kind: "immediate" };

/**
 * One document change a commit adopts: a removal, a draft's prepared change, or both; and for a persisted document
 * what the commit stores of it.
 */
type Adoption = {
	readonly entry: Entry;
	readonly prepared: Prepared<JsonObject> | undefined;
	readonly retires: boolean;
	readonly stored: StoredChange | undefined;
};

/**
 * One transaction of an object, under the seal token of whoever runs it (an attempt, a job run's invocation, the
 * object). Commit prepares every draft (Delta records ops and checks only placed values) and adopts the changed
 * documents and the staged changes in one batch; drafts are revoked once it settles. Cut at its token's seal, it
 * discards everything, releases the line and refuses every later use.
 */
export class Transaction implements Tx {
	readonly #documents: Documents;
	readonly token: SealToken;
	readonly #release: () => void;
	readonly #context: Context;
	readonly #entries = new Map<DocumentSlot, Map<string, Entry>>();
	/** Chord's own staged changes, by their owner (a job); made by the first. */
	#staged: Map<object, Staged> | undefined;
	/**
	 * The store writes, in staging order, and the store they commit to; made by the first (the flag that sends the
	 * commit through the store's step, W12).
	 */
	#writes: { readonly store: ChordStore; readonly staged: StagedWrite[] } | undefined;
	/** The tables written, each with its writes and overlay. */
	#tables: Map<TableHandle, TableChanges> | undefined;
	/** `tx.*` reads underway: a callback settling with one is refused (rule 3, as Durable's). */
	#pending = 0;
	/** When its commit reaches the store (a run state's deferred change, D8). */
	readonly #persistence: CommitPersistence;
	#state: "open" | "committing" | "stepping" | "committed" | "discarded" | "cut" = "open";
	/** Rejected by `cut` while the commit waits in the store's queue: its caller is told at once (rule 3). */
	#queued: PromiseWithResolvers<never> | undefined;

	constructor(
		documents: Documents,
		token: SealToken,
		release: () => void,
		context: Context,
		persistence: CommitPersistence = IMMEDIATE,
	) {
		this.#documents = documents;
		this.token = token;
		this.#release = release;
		this.#context = context;
		this.#persistence = persistence;
	}

	/**
	 * The store writes of this transaction, which `write`s join (Chord's own documents: a job's run records): made by the
	 * first, which sends the commit through `store`'s step.
	 */
	stageStore(store: ChordStore): StagedWrite[] {
		this.#writes ??= { store, staged: [] };
		return this.#writes.staged;
	}

	/** The object whose transaction this is. */
	get documents(): Documents {
		return this.#documents;
	}

	draft<T extends JsonObject>(handle: SingletonHandle<T>): Promise<Draft<T>>;
	draft<T extends JsonObject>(handle: KeyedHandle<T>, key: string): Promise<Draft<T>>;
	draft<T extends JsonObject>(handle: SingletonHandle<T> | KeyedHandle<T>, key = ""): Promise<Draft<T>> {
		// Not `async`: the draft's promise is returned as it is, without another promise around it (the in-memory path
		// stays as cheap as before the store); a throw still reaches the caller as a rejection.
		let slot: SingletonSlot | KeyedSlot;
		let at: string;
		// Keyed keys follow the text rules (`KeyedSlot.key`); a singleton's key is always "".
		try {
			slot = this.#slotOf(handle);
			at = key === "" ? key : slot.key(key);
		} catch (error) {
			return Promise.reject(error);
		}
		// The entry is made for this handle's slot, whose documents are `T`.
		return this.draftSlot(slot, at) as Promise<Draft<T>>;
	}

	/**
	 * The draft of the document at `key` of `slot` (Chord's own slots, a job's run states). A cold persisted document
	 * is loaded first, inside the transaction (it holds the line); the draft counts as pending until it settles (rule
	 * 3). A warm draft settles at once.
	 */
	async draftSlot(slot: DocumentSlot, key: string): Promise<Draft<JsonObject>> {
		const entry = this.#entry(slot, key);
		const persisted = slot.persisted;
		if (entry.draft !== undefined || entry.retire || persisted?.cold(key) !== true) return this.#begin(entry);
		this.#pending++;
		try {
			await persisted.load(key, this.#context, this.token);
			this.#assertOpen();
			return this.#begin(entry);
		} finally {
			this.#pending--;
		}
	}

	retire(handle: SingletonHandle<JsonObject>): Promise<void>;
	retire(handle: KeyedHandle<JsonObject>, key: string): Promise<void>;
	async retire(handle: SingletonHandle<JsonObject> | KeyedHandle<JsonObject>, key = ""): Promise<void> {
		const slot = this.#slotOf(handle);
		const at = key === "" ? key : slot.key(key);
		const entry = this.retireSlot(slot, at);
		const persisted = slot.persisted;
		// A cold persisted document is found, not loaded (one read; absent: a no-op, R13); a version or fingerprint
		// the code cannot read fails the owner as a load would (R15): a retirement of it is no exception.
		if (entry.found === undefined && persisted?.cold(at)) {
			const found = await this.#track(persisted.persistence.find(at, this.#context));
			// Cut meanwhile: its attempt was sealed, and failing the owner now would fail its successor.
			this.#assertOpen();
			if (found !== undefined) checkFound(found, persisted, slot);
			entry.found = found?.stored;
		}
	}

	/** Retires the document at `key` of `slot` when the transaction commits. */
	retireSlot(slot: DocumentSlot, key: string): Entry {
		const entry = this.#entry(slot, key);
		entry.draft?.change.abort();
		entry.draft = undefined;
		entry.retire = true;
		return entry;
	}

	start<A, R, S>(job: JobHandle<A, R, S>, args: A, options: StartOptions = {}): Run<Outcome<A, R, S>> {
		// Job handles are Chord's own: `self.job` made them.
		return (job as unknown as Job).stage(this, args, this.#context, options) as Run<Outcome<A, R, S>>;
	}

	get<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		key: KeyOf<C, K>,
	): Promise<RowOf<C> | undefined> {
		const handle = this.#handle(table);
		const changes = this.#tables?.get(handle);
		const read = changes === undefined ? handle.get(key, this.#context) : changes.get(key, this.#context);
		// The handle's rows are the table's, typed by `C`.
		return this.#track(read) as Promise<RowOf<C> | undefined>;
	}

	page<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		q: Query<C, K>,
		limit: number,
		options: PageOptions = {},
	): Promise<Page<RowOf<C>>> {
		// As in `get`; the query's table is checked against the handle's.
		const read = this.#handle(table).page(q as unknown as Query, limit, this.#context, options);
		return this.#track(read) as Promise<Page<RowOf<C>>>;
	}

	async *rows<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		q: Query<C, K>,
	): AsyncIterable<RowOf<C>> {
		let after: string | undefined;
		do {
			const page = await this.page(table, q, ROWS_PAGE, after === undefined ? {} : { after });
			yield* page.items;
			after = page.next;
		} while (after !== undefined);
	}

	put<C extends Columns, K extends readonly string[]>(table: Table<C, K>, row: PutRowOf<C>): void {
		this.#changes(table).put(row);
	}

	update<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		key: KeyOf<C, K>,
		set: SetOf<C, K> | ((row: ColumnRefs<C>) => SetOf<C, K>),
	): void {
		this.#changes(table).update(key, set);
	}

	delete<C extends Columns, K extends readonly string[]>(table: Table<C, K>, key: KeyOf<C, K>): void {
		this.#changes(table).delete(key);
	}

	updateWhere<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		where: (row: ColumnRefs<C>) => Condition,
		set: SetOf<C, K> | ((row: ColumnRefs<C>) => SetOf<C, K>),
	): void {
		this.#changes(table).updateWhere(where, set);
	}

	deleteWhere<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		where: (row: ColumnRefs<C>) => Condition,
	): void {
		this.#changes(table).deleteWhere(where);
	}

	/** The changes `owner` staged in this transaction, made by `make` on its first use. */
	stage<S extends Staged>(owner: object, make: () => S): S {
		this.#assertOpen();
		this.#staged ??= new Map();
		let staged = this.#staged.get(owner);
		if (staged === undefined) {
			staged = make();
			this.#staged.set(owner, staged);
		}
		// Each owner stages one kind of change, the one its `make` returns.
		return staged as S;
	}

	/** The changes `owner` staged in this transaction so far, if any. */
	staged<S extends Staged>(owner: object): S | undefined {
		// As in `stage`: the owner's own kind.
		return this.#staged?.get(owner) as S | undefined;
	}

	/**
	 * Prepares every draft and adopts what changed, and the staged changes, in one batch; nothing when nothing changed.
	 * A document retired and drafted anew is removed, then adopted: its frame carries the retirement. Persisted
	 * documents stage their writes here (rule 8), which sends the commit through the store's step.
	 */
	commit(): void | Promise<void> {
		this.#assertOpen();
		if (this.#pending > 0)
			throw new Error(`${this.#documents.label}: the callback settled before its pending tx operations`);
		this.#state = "committing";
		this.#context.abortSignal?.throwIfAborted();
		const adoptions: Adoption[] = [];
		for (const entries of this.#entries.values()) {
			for (const entry of entries.values()) {
				let prepared = entry.draft?.change.prepare();
				if (prepared !== undefined && prepared.ops.length === 0) {
					prepared.abort();
					prepared = undefined;
				}
				const { slot, key } = entry;
				const retires = entry.retire && (slot.current(key) !== undefined || entry.found !== undefined);
				if (prepared === undefined && !retires) continue;
				const persisted = slot.persisted;
				let stored: StoredChange | undefined;
				if (persisted !== undefined) {
					const writes = this.stageStore(persisted.persistence.store);
					const was = persisted.stored(key) ?? entry.found;
					stored = persisted.stage(key, { prepared, retires }, was, writes, this.#persistence);
				}
				adoptions.push({ entry, prepared, retires, stored });
			}
		}
		const writes = this.#writes;
		if (writes === undefined) {
			this.#adopt(adoptions);
			this.#state = "committed";
			return;
		}
		return this.#step(writes.store, writes.staged, adoptions);
	}

	/**
	 * Commits through the store's step (§3): admitted while neither cut nor sealed (else `released`, nothing written),
	 * then the documents and staged changes adopted inside the step. Once queued, the caller's abort no longer counts;
	 * a cut while queued rejects `released` at once (the queue drops the entry at its admission, writing nothing).
	 */
	async #step(store: ChordStore, staged: readonly StagedWrite[], adoptions: readonly Adoption[]): Promise<void> {
		const fence = {
			admit: () => {
				if (this.#state !== "committing" || this.token.sealed) return false;
				this.#state = "stepping";
				return true;
			},
			adopt: () => this.#adopt(adoptions),
		};
		this.#queued = Promise.withResolvers<never>();
		try {
			// The race handles the commit's own later rejection too.
			await Promise.race([store.commit(staged, fence, withoutAbortSignal(this.#context)), this.#queued.promise]);
		} catch (error) {
			if (this.#state === "cut") throw this.#cutError();
			throw this.#refused(error);
		} finally {
			this.#queued = undefined;
		}
		this.#state = "committed";
	}

	/**
	 * The error a commit the store rejected rejects with (D4): the store's own (`released`, `storage_failed`) as it
	 * is; a refused step classified, an `int` `CHECK` failing only this transaction (`invalid/args`), any other refusal
	 * failing the live object `broken` too (memory and disk disagree).
	 */
	#refused(error: unknown): unknown {
		const refusal = refusalOf(error, this.#documents.label);
		if (refusal === undefined) return error;
		if (refusal.kind === "broken") this.#documents.fail(refusal.error);
		return refusal.error;
	}

	/**
	 * Adopts the changed documents (persisted ones with what the commit stored of them) and the staged changes in one
	 * batch; nothing when nothing changed.
	 */
	#adopt(adoptions: readonly Adoption[]): void {
		const staged = this.#staged;
		if (adoptions.length === 0 && staged === undefined) return;
		this.#documents.batch.commit(() => {
			for (const { entry, prepared, retires, stored } of adoptions) {
				if (retires) entry.slot.retire(entry.key);
				if (prepared === undefined) continue;
				entry.slot.adopt(entry.key, entry.draft!.tracker, prepared, stored);
			}
			for (const each of staged?.values() ?? []) each.adopt();
		}, this.#context);
	}

	/** Aborts every draft and prepared change. */
	discard(): void {
		if (this.#state === "cut") return;
		this.#state = "discarded";
		this.#abortDrafts();
	}

	/**
	 * Its token was sealed while it held the line: every draft is aborted, the line released, and every later use,
	 * its commit included, throws `released`.
	 */
	cut(): void {
		// A commit admitted to the step runs to its end; one still queued is refused at admission.
		if (this.#state !== "open" && this.#state !== "committing") return;
		this.#state = "cut";
		this.#abortDrafts();
		this.#release();
		this.#queued?.reject(this.#cutError());
	}

	/** Tells the staged changes how the transaction ended; runs once the object's line is free. */
	settle(): void {
		if (this.#staged === undefined) return;
		const committed = this.#state === "committed";
		for (const staged of this.#staged.values()) {
			if (committed) staged.committed();
			else staged.discarded();
		}
	}

	#abortDrafts(): void {
		for (const entries of this.#entries.values()) for (const entry of entries.values()) entry.draft?.change.abort();
	}

	/** The slot behind a handle of this object, after the handle's version fence (R15). */
	#slotOf(handle: SingletonHandle<JsonObject> | KeyedHandle<JsonObject>): SingletonSlot | KeyedSlot {
		// Handles are Chord's own: `self.state` made them.
		const { slot, version } = handle as Singleton | Keyed;
		slot.definition.assertVersion(version);
		return slot;
	}

	#entry(slot: DocumentSlot, key: string): Entry {
		this.#assertOpen();
		if (slot.owner !== this.#documents) {
			throw new Error(`${this.#documents.label}: a transaction drafts only its own object's documents`);
		}
		let entries = this.#entries.get(slot);
		if (entries === undefined) {
			entries = new Map();
			this.#entries.set(slot, entries);
		}
		let entry = entries.get(key);
		if (entry === undefined) {
			entry = { slot, key, draft: undefined, retire: false, found: undefined };
			entries.set(key, entry);
		}
		return entry;
	}

	#assertOpen(): void {
		if (this.#state === "open") return;
		if (this.#state === "cut") throw this.#cutError();
		throw new Error(`${this.#documents.label}: the transaction has settled`);
	}

	#cutError(): ChordError {
		return new ChordError({
			code: "released",
			reason: "discarded",
			message: `${this.#documents.label}: the transaction was discarded at the seal`,
		});
	}

	/** The handle behind `table`, one of this object's tables (another object's is refused). */
	#handle(table: object): TableHandle {
		this.#assertOpen();
		// Plugin code may pass any table: only this object's handles are taken.
		const handle = table;
		if (!(handle instanceof TableHandle) || handle.owner.scope !== this.#documents) {
			throw new Error(`${this.#documents.label}: a transaction writes only its own object's tables`);
		}
		return handle;
	}

	/** The writes to `table` in this transaction, made by the first. */
	#changes(table: object): TableChanges {
		const handle = this.#handle(table);
		this.#tables ??= new Map();
		let changes = this.#tables.get(handle);
		if (changes === undefined) {
			this.#writes ??= { store: handle.store, staged: [] };
			changes = new TableChanges(handle, this.#writes.staged);
			this.#tables.set(handle, changes);
		}
		return changes;
	}

	/** Counts `read` as pending until the operation's promise settles (rule 3). */
	async #track<T>(read: Promise<T>): Promise<T> {
		this.#pending++;
		try {
			return await read;
		} finally {
			this.#pending--;
		}
	}

	/** The entry's draft, begun on the current document (or a fresh `initial()`) by the first use. */
	#begin(entry: Entry): Draft<JsonObject> {
		if (entry.draft === undefined) {
			const { slot, key } = entry;
			const current = entry.retire ? undefined : slot.current(key);
			const tracker = current ?? track(slot.initial(this.#context));
			entry.draft = { tracker, change: tracker.beginChange() };
		}
		return entry.draft.change.state;
	}
}

/** Throws, failing `slot`'s owner `broken`, when its definition cannot read the cold document `found` (R15). */
function checkFound(found: FoundDocument, persisted: PersistedSlot, slot: DocumentSlot): void {
	try {
		checkReadable({ version: found.stored.version, fingerprint: found.fingerprint }, persisted.definition.current);
	} catch (error) {
		const failure = asChordError(error, slot.owner.label);
		slot.owner.fail(failure);
		throw failure;
	}
}
