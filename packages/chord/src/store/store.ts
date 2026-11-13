// The store (slice 6a §2, §3, slice 6b §1): opened over a backend, one commit queue that serializes only the commit
// step (the seal fence's admission check, `BEGIN`, the writes in their order, the outbox commit, `lastSeq` and the
// allocator's value, `COMMIT`, then the owner's adoption), group commit (S18: the commits queued behind a running step
// share the next step's backend transaction), the id allocator, the claims of its tables and documents, reads guarded
// as Durable's `GuardedStorage` guards them, Durable's Storage semantics for a refused step (D4), and the stop after an
// unknown outcome.

import { awaitWithContext, type Context } from "../context/index.ts";
import { ChordError } from "../data/index.ts";
import { invalid } from "../data/internal.ts";
import type { SqliteDatabase, SqliteExecutor } from "../sqlite/index.ts";
import type { Batch } from "../state/internal.ts";
import { chordMetrics } from "../telemetry.ts";
import { IdAllocator } from "./allocator.ts";
import type { ArchivePart } from "./archive.ts";
import type { Backend } from "./backend.ts";
import { readCatalog, type TableRecord, writeCatalog } from "./catalog.ts";
import { Claims } from "./claims.ts";
import { StoreExport } from "./export.ts";
import { OUTBOX_FORMAT, Outbox } from "./outbox.ts";
import { applyStoreSchema, type MetaRow, TABLES } from "./schema.ts";
import { type StagedWrite, Step, type WriteOrder } from "./step.ts";
import type { StoreWrite } from "./writes.ts";

/** A store as apps hold it: opened by `openStore`, owned and closed by the app. */
export interface Store {
	/** The seq of the store's last commit (0 for a new store). */
	readonly lastSeq: number;
	/** The outbox the sync layer reads; `undefined` without one. */
	readonly outbox: Outbox | undefined;
	/**
	 * Calls `listener` with the new `lastSeq` after commits are durable and adopted (a commit, a group, a series, an
	 * applied batch): in a microtask of its own, never inside a commit, once for however many commits it covers. A
	 * listener that throws is removed and its error handed to `onError`, never to the commit. Commits a listener makes
	 * are announced like any other. Returns its removal.
	 */
	onCommitted(listener: (lastSeq: number) => void, onError: (error: unknown) => void): () => void;
	/**
	 * The store's state after its `lastSeq` as archive parts (slice 6a §13), holding the commit queue from the first
	 * `next()` until the iteration ends, throws, is closed or `context` aborts.
	 */
	export(context: Context): AsyncIterableIterator<ArchivePart>;
	/**
	 * Closes the store: waits for a running commit step (a group's, its commits' solo runs included), rejects queued
	 * commits and reads `released`, closes the backend. Idempotent, also after `storage_failed`; `context` ends only
	 * this caller's wait (the close goes on).
	 */
	close(context: Context): Promise<void>;
}

/** What `openStore` takes besides the backend. */
export type StoreOptions = {
	/** Turns the outbox on (`true`) or off (`false`); omitted, the persisted setting stays (a new store: off). */
	readonly outbox?: boolean;
};

/**
 * Opens a store over `backend`: the store's schema migrations, the UTF-8 check, the metadata read once, the outbox
 * switched when asked. A failure closes the backend and rejects (rule 12).
 */
export async function openStore(backend: Backend, context: Context, options: StoreOptions = {}): Promise<Store> {
	const { db } = backend;
	try {
		context.abortSignal?.throwIfAborted();
		const meta = await switchOutbox(db, await applyStoreSchema(db), options.outbox);
		return new ChordStore(db, meta, await readCatalog(db));
	} catch (error) {
		try {
			await db.close();
		} catch {
			// The open's own failure is the one to report.
		}
		throw error;
	}
}

/** Turns the outbox on (from the current `lastSeq`) or off (its commits dropped) when `outbox` asks for the other. */
async function switchOutbox(db: SqliteDatabase, meta: MetaRow, outbox: boolean | undefined): Promise<MetaRow> {
	if (outbox === undefined || outbox === (meta.outbox === 1)) return meta;
	const floor = outbox ? meta.last_seq : 0;
	await db.transaction(async (executor) => {
		await executor.run(
			`UPDATE ${TABLES.meta} SET outbox = ?, outbox_floor = ? WHERE singleton = 1`,
			outbox ? 1 : 0,
			floor,
		);
		if (!outbox) await executor.run(`DELETE FROM ${TABLES.outbox}`);
	});
	return { ...meta, outbox: outbox ? 1 : 0, outbox_floor: floor };
}

/** The seal fence's two checks of a commit (§1.3), as the commit step calls them. */
export type CommitFence = {
	/** At the step's entry: `false` rejects the commit `released` and writes nothing. */
	admit(): boolean;
	/**
	 * After `COMMIT`: adopts the commit, `ids` being its created documents' ids in the order of their writes, `rows` the
	 * table rows its writes changed.
	 */
	adopt(seq: number, ids: readonly number[], rows: number): void;
};

/**
 * One commit of a series (`ChordStore.commitSeries`): its own checks, which write nothing, and its writes. The checks
 * read through the commit's step, which sees what the series' earlier commits wrote.
 */
export type SeriesCommit = {
	/** Throws to refuse the commit: the series stops before it, the commits before it stand. */
	check(step: Step): Promise<void>;
	readonly writes: readonly StagedWrite[];
};

/** What a series stored: how many of its commits, and why the next one was refused, if one was. */
export type SeriesResult = { readonly stored: number; readonly refused?: unknown };

/**
 * The commits of one backend transaction (a series or a group) as it leaves them: each stored commit's seq and created
 * documents; once a commit wrote, the last seq, the allocator's value after it and the table records they changed; the
 * commits that wrote and the statements run.
 */
type Written = {
	readonly stored: readonly { readonly seq: number; readonly created: readonly number[] }[];
	readonly last:
		| { readonly seq: number; readonly nextId: number; readonly tables: ReadonlyMap<string, TableRecord> }
		| undefined;
	readonly written: number;
	readonly statements: number;
};

/**
 * The commits of one backend transaction (a series or a group) while it runs: each stored commit's seq and created
 * documents, the last step that wrote, the allocator's value after it, the table records they changed (a copy of the
 * catalog, made once one changed) and the statements run.
 */
type Progress = {
	readonly stored: { readonly seq: number; readonly created: readonly number[] }[];
	last: Step | undefined;
	nextId: number;
	changed: Map<string, TableRecord> | undefined;
	statements: number;
};

/** What the open host gives the store: its `storage_failed` listener and its batch, in which adapters publish (§1.3). */
export type Attachment = {
	readonly failed: (error: unknown) => void;
	readonly batch: Batch;
};

/** A group as its transaction leaves it: each commit's step and the allocator's value after it, in order; the whole. */
type GroupWritten = {
	readonly steps: readonly { readonly step: Step; readonly nextId: number }[];
	readonly written: Written;
};

/** A commit waiting in the commit queue for its group's turn: what `commit` was given, and its caller's promise. */
type QueuedCommit = {
	readonly writes: readonly StagedWrite[];
	readonly fence: CommitFence;
	readonly context: Context;
	readonly resolve: (seq: number) => void;
	readonly reject: (error: unknown) => void;
};

/** Where a replayed batch leaves the store: its last commit's seq and allocator value, the tables it changed. */
export type Replayed = {
	readonly lastSeq: number;
	readonly nextId: number;
	readonly tables: ReadonlyMap<string, TableRecord>;
};

/** Where a store stands: open, stopped by a backend error, or closed. */
type StoreState =
	| { readonly kind: "open" }
	| { readonly kind: "failed"; readonly error: unknown }
	| { readonly kind: "closed" };

const ORDER: readonly WriteOrder[] = ["retire", "create", "write"];

const NOTHING = (): void => {};

/** The step's own error, until its callback throws one: a distinct value no thrown error can be. */
const NONE: unique symbol = Symbol("none");

/** The store behind `Store`, with what Chord's layers use: commits, guarded reads, the host's failure listener. */
export class ChordStore implements Store {
	readonly #db: SqliteDatabase;
	#lastSeq: number;
	/** The allocator's value as the last commit persisted it (an export's manifest). */
	#committedNextId: number;
	readonly #ids: IdAllocator;
	/** The claims of its tables and documents (slice 6b). */
	readonly claims = new Claims();
	#outbox: Outbox | undefined;
	#state: StoreState = { kind: "open" };
	/**
	 * The backend error that stopped the store, also when it happened while the store was closing (the state stays
	 * `closed` then): an admitted commit still running after it is refused.
	 */
	#failure: { readonly error: unknown } | undefined;
	/** Set once a batch's recorded count did not reproduce (S17): no batch applies any more. */
	#diverged = false;
	/** The commit queue's tail: each step starts after the one before it settled. */
	#tail: Promise<void> = Promise.resolve();
	/** The group the next commit joins: queued last, its turn not yet come; `undefined` once anything queued after it. */
	#open: QueuedCommit[] | undefined;
	/** Reads and maintenance writes underway, which `close` waits for. */
	#underway = 0;
	/** Resolves `close`'s wait once no read is underway. */
	#drained: (() => void) | undefined;
	/** The open host's listener for `storage_failed` (told once) and batch; one host per store (rule 7). */
	#attachment: Attachment | undefined;
	#closing: Promise<void> | undefined;
	/** The versions migrations of tables announced (`announceTable`), by SQL name, until their last commit. */
	readonly #announced = new Map<string, number>();
	/** The recorded tables, by SQL name; changed only after a step's `COMMIT`. */
	readonly #catalog: Map<string, TableRecord>;
	/** The ends of the exports holding the queue or waiting for it, which closing the store calls. */
	readonly #held = new Set<() => void>();
	/** `onCommitted` listeners, and whether an announcement is queued (one per microtask, with the last `lastSeq`). */
	readonly #committedListeners = new Map<(lastSeq: number) => void, (error: unknown) => void>();
	#announcing = false;

	constructor(db: SqliteDatabase, meta: MetaRow, catalog: Map<string, TableRecord>) {
		this.#db = db;
		this.#catalog = catalog;
		this.#lastSeq = meta.last_seq;
		this.#committedNextId = meta.next_id;
		this.#ids = new IdAllocator(meta.next_id);
		this.#outbox = meta.outbox === 1 ? new Outbox(this, meta.outbox_floor) : undefined;
	}

	get lastSeq(): number {
		return this.#lastSeq;
	}

	get outbox(): Outbox | undefined {
		return this.#outbox;
	}

	onCommitted(listener: (lastSeq: number) => void, onError: (error: unknown) => void): () => void {
		this.#committedListeners.set(listener, onError);
		return () => this.#committedListeners.delete(listener);
	}

	/** Announces the new `lastSeq` to `onCommitted` listeners in one microtask, however many commits it covers. */
	#committed(): void {
		if (this.#announcing || this.#committedListeners.size === 0) return;
		this.#announcing = true;
		queueMicrotask(() => {
			this.#announcing = false;
			const seq = this.#lastSeq;
			for (const [listener, onError] of [...this.#committedListeners]) {
				try {
					listener(seq);
				} catch (error) {
					this.#committedListeners.delete(listener);
					onError(error);
				}
			}
		});
	}

	/** The allocator's value as the last commit persisted it. */
	get nextId(): number {
		return this.#committedNextId;
	}

	/** The id allocator: `mint` takes the next id, `raise` makes room above an explicit one (D3). */
	get ids(): IdAllocator {
		return this.#ids;
	}

	/** Takes the next id from the allocator (Durable's `mintId`); refused once the store stopped or closed. */
	mintId(): number {
		this.assertUsable();
		return this.#ids.mint();
	}

	/** The open host's batch, in which an adapter publishes its commits; `undefined` without a host. */
	get batch(): Batch | undefined {
		return this.#attachment?.batch;
	}

	/** Every recorded table, by SQL name, as of the last commit. */
	get tables(): ReadonlyMap<string, TableRecord> {
		return this.#catalog;
	}

	export(context: Context): AsyncIterableIterator<ArchivePart> {
		this.assertUsable();
		return new StoreExport(this, context);
	}

	/**
	 * Takes the commit queue (an export): resolves once every earlier commit settled, with the release that lets the
	 * later ones run (idempotent). Closing the store calls `end` (from the call on, also while waiting, and at once for a
	 * store closed before the call took the queue), which must release.
	 */
	take(end: () => void): Promise<() => void> {
		const held = Promise.withResolvers<void>();
		const release = (): void => {
			this.#held.delete(end);
			held.resolve();
		};
		this.#held.add(end);
		this.#open = undefined;
		const taken = this.#tail.then(() => {
			// A store closed meanwhile (also before the export's first `next()`) holds nothing: the export ends.
			if (this.#state.kind === "closed") {
				release();
				end();
			}
			return release;
		});
		this.#tail = taken.then(() => held.promise);
		return taken;
	}

	/** The recorded table `name` (its SQL name), as of the last commit. */
	table(name: string): TableRecord | undefined {
		return this.#catalog.get(name);
	}

	/**
	 * The version table `name` is at or is being migrated to: the recorded one, or a higher one a migration announced
	 * before its first commit (`announceTable`), so an old handle is refused before its SQL could queue behind the
	 * migration's DDL (fix round 1, Sol 8).
	 */
	tableVersion(name: string): number | undefined {
		const recorded = this.#catalog.get(name)?.version;
		const announced = this.#announced.get(name);
		return announced === undefined || (recorded !== undefined && recorded >= announced) ? recorded : announced;
	}

	/** Announces a migration of table `name` to `version` until the returned withdrawal (after its last commit). */
	announceTable(name: string, version: number): () => void {
		this.#announced.set(name, version);
		return () => {
			if (this.#announced.get(name) === version) this.#announced.delete(name);
		};
	}

	/** Attaches the open host; a store attached to an open host is refused (rule 7). */
	attach(attachment: Attachment): void {
		if (this.#attachment !== undefined) {
			throw new ChordError({ code: "invalid", reason: "args", message: "store: already attached to an open host" });
		}
		this.#attachment = attachment;
	}

	/** The host closed: the store may serve another one. */
	detach(): void {
		this.#attachment = undefined;
	}

	/**
	 * Commits `writes` as one seq when the commit queue reaches it: `fence.admit()` at the entry of its step (its
	 * group's), the writes in their order (retirements, creations, the rest), the outbox commit, `lastSeq` and the
	 * allocator's value, `COMMIT`, then `fence.adopt` before the next step starts. Resolves with the seq. A refused
	 * admission rejects `released`. A step the backend rolled back after the step's own code threw (a refusal, D4)
	 * rejects with that error unchanged and the store goes on; any other failure (`BEGIN`, `COMMIT`, `ROLLBACK`, a
	 * throwing `adopt` or metrics adapter) is an unknown outcome that stops the store (`storage_failed`). `context`
	 * counts the step (no abort once queued).
	 *
	 * Group commit: the commits queued while a step runs form one group, which the next turn admits and writes in one
	 * backend transaction (each commit its own seq, outbox commit and adoption, in queue order; the metadata once), so a
	 * busy store costs a transaction per group, not per commit. If one of them refuses, the group rolls back and its
	 * commits run again one by one as above: the refusal stays its own commit's.
	 */
	commit(writes: readonly StagedWrite[], fence: CommitFence, context: Context): Promise<number> {
		try {
			this.assertUsable();
		} catch (error) {
			return Promise.reject(error);
		}
		const { promise, resolve, reject } = Promise.withResolvers<number>();
		const queued: QueuedCommit = { writes, fence, context, resolve, reject };
		// An empty commit takes no transaction: it neither joins nor opens a group.
		if (writes.length > 0 && this.#open !== undefined) {
			this.#open.push(queued);
			return promise;
		}
		const group = [queued];
		// What a turn throws past its own handling (a host's `failed` listener throwing in `#fail`) rejects its commits,
		// as it rejected a lone step; rejecting a settled one does nothing. The queue goes on either way.
		this.#tail = this.#tail
			.then(() => this.#group(group))
			.catch((error: unknown) => {
				for (const each of group) each.reject(error);
			});
		this.#open = writes.length > 0 ? group : undefined;
		return promise;
	}

	/**
	 * Commits `commits` in one backend transaction when the commit queue reaches them, one seq each, in order: each
	 * commit's `check`, which writes nothing, then its writes as `commit` writes them, with its own outbox commit and the
	 * metadata (a commit without writes takes no seq: it stands at the one before). A `check` that throws refuses its
	 * commit: the series stops there and the transaction commits the ones before it. A check whose backend statement
	 * failed, and a throw of a commit's writes, roll the whole series back and reject with that error, the store going
	 * on (D4); any other failure is an unknown outcome that stops the store, as for `commit`. After `COMMIT`,
	 * `receive(index, seq, ids)` is called per stored commit, in order, before the next step starts (`ids`: its created
	 * documents). Resolves with what it stored.
	 */
	commitSeries(
		commits: readonly SeriesCommit[],
		receive: (index: number, seq: number, ids: readonly number[]) => void,
		context: Context,
	): Promise<SeriesResult> {
		try {
			this.assertUsable();
		} catch (error) {
			return Promise.reject(error);
		}
		this.#open = undefined;
		const series = this.#tail.then(() => this.#series(commits, receive, context));
		this.#tail = series.then(NOTHING, NOTHING);
		return series;
	}

	/**
	 * Runs `read` on the backend under the guard (rule 11, Durable's `GuardedStorage`): refused once the store stopped
	 * or closed; a backend error fails the store unless `context` was aborted (then `aborted`); a read settling after
	 * the store stopped rejects `unavailable/storage_failed`. `read` returns data and never throws for a request: an
	 * adapter checks a request from what it returned, after the guard (slice 6b §1.4).
	 */
	read<T>(read: (executor: SqliteExecutor) => Promise<T>, context: Context): Promise<T> {
		return this.#guarded(() => read(this.#db), context);
	}

	/**
	 * `read` for several queries that must see one state (S4, a document from its record and revisions): one backend
	 * transaction, guarded as `read`.
	 */
	readTransaction<T>(read: (executor: SqliteExecutor) => Promise<T>, context: Context): Promise<T> {
		return this.#guarded(() => this.#db.transaction(read), context);
	}

	async #guarded<T>(run: () => Promise<T>, context: Context): Promise<T> {
		this.assertUsable();
		this.#underway++;
		let result: T;
		try {
			// A read throwing before its first await is the backend's too: inside the `try`.
			result = await run();
		} catch (error) {
			const signal = context.abortSignal;
			// Latched before the closed check: a backend failure while closing still refuses later admitted commits.
			if (!signal?.aborted) this.#failure ??= { error };
			this.assertUsable();
			if (signal?.aborted)
				throw new ChordError({ code: "aborted", message: "store: read aborted" }, { cause: signal.reason });
			throw this.#fail(error);
		} finally {
			this.#settle();
		}
		this.assertUsable();
		return result;
	}

	/** One read or maintenance write settled: `close` goes on once none is underway. */
	#settle(): void {
		if (--this.#underway === 0) this.#drained?.();
	}

	/**
	 * Runs `write` on the backend outside the commit queue (the outbox's `trim`), in a backend transaction, guarded as
	 * a read without a context: any error stops the store.
	 */
	async maintain(write: (executor: SqliteExecutor) => Promise<void>): Promise<void> {
		this.assertUsable();
		this.#underway++;
		try {
			await this.#db.transaction(write);
		} catch (error) {
			// Latched before the closed check, as for a read.
			this.#failure ??= { error };
			this.assertUsable();
			throw this.#fail(error);
		} finally {
			this.#settle();
		}
	}

	close(context: Context): Promise<void> {
		this.#closing ??= this.#close();
		return awaitWithContext(this.#closing, context);
	}

	async #close(): Promise<void> {
		this.#state = { kind: "closed" };
		for (const end of [...this.#held]) end();
		await this.#tail;
		if (this.#underway > 0) {
			await new Promise<void>((resolve) => {
				this.#drained = resolve;
			});
		}
		await this.#db.close();
	}

	/**
	 * A group's turn (it takes no more commits from here): its commits admitted together at its entry, one as its own
	 * step, several written in one backend transaction (`#grouped`). Settles every commit's promise.
	 */
	async #group(group: readonly QueuedCommit[]): Promise<void> {
		if (this.#open === group) this.#open = undefined;
		try {
			this.assertUsable();
		} catch (error) {
			for (const queued of group) queued.reject(error);
			return;
		}
		// Admitted together at the group's entry, as one step admits its commit: each runs to its end from here.
		const admitted = group.filter((queued) => {
			try {
				if (queued.fence.admit()) return true;
				queued.reject(discarded());
			} catch (error) {
				// As a lone step: a throwing admission rejects its commit with that error, the queue goes on.
				queued.reject(error);
			}
			return false;
		});
		if (admitted.length === 1) {
			const [queued] = admitted;
			return this.#alone(queued!, () => this.#admittedStep(queued!.writes, queued!.fence, queued!.context));
		}
		if (admitted.length > 1) await this.#grouped(admitted);
	}

	/** Settles `queued`'s promise with `step`, its own step. */
	async #alone(queued: QueuedCommit, step: () => Promise<number>): Promise<void> {
		try {
			queued.resolve(await step());
		} catch (error) {
			queued.reject(error);
		}
	}

	/**
	 * Admitted commits in one backend transaction, each on its own step and seq, the metadata once; after `COMMIT`,
	 * memory, the counts and each commit's adoption in order. When a commit's own writes throw (a refusal, D4), the
	 * transaction rolls back whole and every commit runs again alone, admitted already: only the ones whose own writes
	 * throw are refused, as without grouping. Any other failure is an unknown outcome that stops the store.
	 */
	async #grouped(admitted: readonly QueuedCommit[]): Promise<void> {
		// Near the end of the seq range, alone: the commits that still fit are stored, the first past it stops the store.
		if (this.#lastSeq + admitted.length > Number.MAX_SAFE_INTEGER) {
			await this.#eachAlone(admitted);
			return;
		}
		let thrown: unknown = NONE;
		let done: GroupWritten;
		try {
			done = await this.#db.transaction(async (executor) => {
				try {
					return await this.#writeGroup(admitted, executor);
				} catch (error) {
					thrown = error;
					throw error;
				}
			});
		} catch (error) {
			if (error !== thrown) {
				const failed = this.#fail(error);
				for (const queued of admitted) queued.reject(failed);
				return;
			}
			await this.#eachAlone(admitted);
			return;
		}
		this.#adoptGroup(admitted, done);
	}

	/** Runs admitted commits one by one, each its own step, in order. */
	async #eachAlone(admitted: readonly QueuedCommit[]): Promise<void> {
		for (const queued of admitted) {
			await this.#alone(queued, () => this.#admittedStep(queued.writes, queued.fence, queued.context));
		}
	}

	/** The admitted commits' writes in their backend transaction, each on its own step, then the metadata once. */
	async #writeGroup(admitted: readonly QueuedCommit[], executor: SqliteExecutor): Promise<GroupWritten> {
		const progress: Progress = {
			stored: [],
			last: undefined,
			nextId: this.#ids.value,
			changed: undefined,
			statements: 0,
		};
		const steps: { step: Step; nextId: number }[] = [];
		for (const queued of admitted) {
			// A grouped commit has writes: `commit` never groups an empty one.
			const step = (await this.#writeCommit(queued.writes, executor, progress))!;
			steps.push({ step, nextId: progress.nextId });
		}
		return { steps, written: await this.#closeWrites(progress) };
	}

	/**
	 * After a group's `COMMIT`, commit by commit as after a lone step: memory follows it, it counts through its own
	 * context (the metadata statement ran on the last one's step), it is adopted. Anything that throws here (an adoption,
	 * a metrics adapter) is an unknown outcome: memory takes the whole group (it is durable), the store stops, and that
	 * commit and the ones after it reject `storage_failed`, unadopted.
	 */
	#adoptGroup(admitted: readonly QueuedCommit[], { steps, written }: GroupWritten): void {
		let index = 0;
		try {
			for (; index < admitted.length; index++) {
				const queued = admitted[index]!;
				const { step, nextId } = steps[index]!;
				this.#lastSeq = step.seq;
				this.#committedNextId = nextId;
				for (const [name, record] of step.tables) this.#catalog.set(name, record);
				const metrics = chordMetrics(queued.context.telemetry.metrics);
				metrics.counter("chord.store.commits").add(1);
				metrics.counter("chord.store.statements").add(step.statements);
				queued.fence.adopt(step.seq, step.created, step.rows);
				queued.resolve(step.seq);
			}
		} catch (error) {
			const last = written.last!;
			this.#lastSeq = last.seq;
			this.#committedNextId = last.nextId;
			for (const [name, record] of last.tables) this.#catalog.set(name, record);
			const failed = this.#fail(error);
			for (const rest of admitted.slice(index)) rest.reject(failed);
		}
		// Durable either way: the whole group is stored.
		this.#committed();
	}

	/**
	 * An admitted commit's step (`commit`'s semantics after admission; `fence` only adopts): it runs to its end, also
	 * when the store closes meanwhile (close waits for it); only a backend failure before it, closing or not, refuses it.
	 */
	async #admittedStep(writes: readonly StagedWrite[], fence: CommitFence, context: Context): Promise<number> {
		if (this.#failure !== undefined) throw storageFailed(this.#failure.error);
		if (writes.length === 0) {
			// An empty commit takes no seq; a throwing `adopt` stops the store as for any commit.
			try {
				fence.adopt(this.#lastSeq, [], 0);
			} catch (error) {
				throw this.#fail(error);
			}
			return this.#lastSeq;
		}
		const seq = this.#lastSeq + 1;
		// Past the safe range seqs stop counting exactly (a later one would repeat): the store cannot number further.
		if (seq > Number.MAX_SAFE_INTEGER) throw this.#fail(new Error("store: no seq past Number.MAX_SAFE_INTEGER"));
		let thrown: unknown = NONE;
		let done: { readonly step: Step; readonly nextId: number };
		try {
			done = await this.#db.transaction(async (executor) => {
				try {
					const step = new Step(executor, seq, this.#ids, this.#catalog);
					const nextId = await this.#write(step, writes);
					await writeMeta(step, nextId);
					return { step, nextId };
				} catch (error) {
					thrown = error;
					throw error;
				}
			});
		} catch (error) {
			// The facade rolled back and rejects with the step's own error: a refusal, the store goes on (D4).
			if (error === thrown) throw error;
			throw this.#fail(error);
		}
		// `COMMIT` returned: the commit is durable, and memory follows.
		const { step, nextId } = done;
		this.#lastSeq = seq;
		this.#committedNextId = nextId;
		for (const [name, record] of step.tables) this.#catalog.set(name, record);
		this.#committed();
		// Anything that throws from here (a metrics adapter, the adoption) leaves the commit durable and unadopted: an
		// unknown outcome that stops the store.
		try {
			const metrics = chordMetrics(context.telemetry.metrics);
			metrics.counter("chord.store.commits").add(1);
			metrics.counter("chord.store.statements").add(step.statements);
			fence.adopt(seq, step.created, step.rows);
		} catch (error) {
			throw this.#fail(error);
		}
		return seq;
	}

	/**
	 * A series inside one backend transaction: per commit a step at the next seq, its check (a throw refuses it, unless
	 * one of its statements failed), then its writes; then, after `COMMIT`, memory and the receipts as after a lone step.
	 */
	async #series(
		commits: readonly SeriesCommit[],
		receive: (index: number, seq: number, ids: readonly number[]) => void,
		context: Context,
	): Promise<SeriesResult> {
		this.assertUsable();
		// Past the safe range seqs stop counting exactly (a later one would repeat): the store cannot number further. Only
		// a commit with writes takes a seq, as for `commit`.
		let seqs = 0;
		for (const commit of commits) if (commit.writes.length > 0) seqs++;
		if (this.#lastSeq + seqs > Number.MAX_SAFE_INTEGER) {
			throw this.#fail(new Error("store: no seq past Number.MAX_SAFE_INTEGER"));
		}
		let thrown: unknown = NONE;
		let refused: { readonly error: unknown } | undefined;
		let done: Written;
		try {
			done = await this.#db.transaction(async (executor) => {
				try {
					return await this.#writeSeries(executor, commits, (error) => {
						refused = { error };
					});
				} catch (error) {
					thrown = error;
					throw error;
				}
			});
		} catch (error) {
			// The facade rolled back and rejects with the series' own error: the store goes on (D4).
			if (error === thrown) throw error;
			throw this.#fail(error);
		}
		// `COMMIT` returned: the stored commits are durable, and memory follows.
		const { stored, last, written, statements } = done;
		if (last !== undefined) {
			this.#lastSeq = last.seq;
			this.#committedNextId = last.nextId;
			for (const [name, record] of last.tables) this.#catalog.set(name, record);
			this.#committed();
		}
		// As after a lone step: a throw from here (a metrics adapter, a receipt) stops the store.
		try {
			const metrics = chordMetrics(context.telemetry.metrics);
			metrics.counter("chord.store.commits").add(written);
			metrics.counter("chord.store.statements").add(statements);
			for (const [index, { seq, created }] of stored.entries()) receive(index, seq, created);
		} catch (error) {
			throw this.#fail(error);
		}
		return refused === undefined ? { stored: stored.length } : { stored: stored.length, refused: refused.error };
	}

	/**
	 * The commits of a series in its backend transaction, until one is refused (`refuse`): each commit's check, then its
	 * writes; the metadata once, at the end.
	 */
	async #writeSeries(
		executor: SqliteExecutor,
		commits: readonly SeriesCommit[],
		refuse: (error: unknown) => void,
	): Promise<Written> {
		const calls = { failed: false };
		const watched = watchCalls(executor, calls);
		const progress: Progress = {
			stored: [],
			last: undefined,
			nextId: this.#ids.value,
			changed: undefined,
			statements: 0,
		};
		for (const commit of commits) {
			const refusal = await this.#checkCommit(commit, watched, calls, progress);
			if (refusal !== undefined) {
				refuse(refusal.error);
				break;
			}
			await this.#writeCommit(commit.writes, executor, progress);
		}
		return this.#closeWrites(progress);
	}

	/**
	 * Runs `commit`'s check on a step at the series' next seq whose backend calls are watched; resolves with its refusal,
	 * if it refused. A check one of whose backend calls failed throws instead: a failure, not a refusal.
	 */
	async #checkCommit(
		commit: SeriesCommit,
		watched: SqliteExecutor,
		calls: { failed: boolean },
		progress: Progress,
	): Promise<{ readonly error: unknown } | undefined> {
		const step = new Step(watched, this.#nextSeq(progress), this.#ids, progress.changed ?? this.#catalog);
		calls.failed = false;
		try {
			await commit.check(step);
			return undefined;
		} catch (error) {
			if (calls.failed) throw error;
			return { error };
		} finally {
			progress.statements += step.statements;
		}
	}

	/**
	 * Writes a commit's `writes` on its own step at the series' next seq (`#write`), unwatched, and keeps the table
	 * records it changed in a copy of the catalog, made only once one changed; resolves with the step. A commit without
	 * writes takes no seq and no step.
	 */
	async #writeCommit(
		writes: readonly StagedWrite[],
		executor: SqliteExecutor,
		progress: Progress,
	): Promise<Step | undefined> {
		const seq = this.#nextSeq(progress);
		if (writes.length === 0) {
			progress.stored.push({ seq: seq - 1, created: [] });
			return undefined;
		}
		const step = new Step(executor, seq, this.#ids, progress.changed ?? this.#catalog);
		progress.nextId = await this.#write(step, writes);
		progress.statements += step.statements;
		if (step.tables.size > 0) {
			progress.changed ??= new Map(this.#catalog);
			for (const [name, record] of step.tables) progress.changed.set(name, record);
		}
		progress.last = step;
		progress.stored.push({ seq, created: step.created });
		return step;
	}

	/** The seq the series' next commit takes. */
	#nextSeq(progress: Progress): number {
		return (progress.last?.seq ?? this.#lastSeq) + 1;
	}

	/** Ends a transaction's writes with the metadata once, after its last commit that wrote; returns what memory takes. */
	async #closeWrites(progress: Progress): Promise<Written> {
		const { stored, last, nextId, changed, statements } = progress;
		if (last === undefined) return { stored, last: undefined, written: 0, statements };
		await writeMeta(last, nextId);
		return {
			stored,
			last: { seq: last.seq, nextId, tables: changed ?? new Map() },
			written: last.seq - this.#lastSeq,
			statements: statements + 1,
		};
	}

	/**
	 * The step's writes inside its backend transaction: each staged write in its phase, the catalog, the outbox commit.
	 * Returns the allocator's value, taken once, after the writes applied (mints meanwhile only raise it); the metadata
	 * (`writeMeta`) is the caller's.
	 */
	async #write(step: Step, writes: readonly StagedWrite[]): Promise<number> {
		const seq = step.seq;
		const recorded: StoreWrite[] | undefined = this.#outbox !== undefined ? [] : undefined;
		for (const order of ORDER) {
			for (const write of writes) {
				if (write.order !== order) continue;
				const done = await write.apply(step);
				recorded?.push(...done);
			}
		}
		await writeCatalog(step);
		const nextId = this.#ids.value;
		if (recorded !== undefined) {
			await step.run(
				`INSERT INTO ${TABLES.outbox} (seq, format, next_id, writes) VALUES (?, ?, ?, ?)`,
				seq,
				OUTBOX_FORMAT,
				nextId,
				JSON.stringify(recorded),
			);
		}
		return nextId;
	}

	/**
	 * Batch apply's turn (slice 6b §1.6, S5): refused (`invalid/args`) while an owner holds a claim (its memory would
	 * go stale) and once the store diverged; otherwise `apply` runs in the commit queue, in one backend transaction, and
	 * returns the position its last commit leaves (`lastSeq`, the allocator's value) and the tables it changed, which
	 * memory takes after `COMMIT`. `apply`'s own error rolls back and rejects as a refusal (a `Diverged` one marks the
	 * store diverged); any other failure stops the store.
	 */
	replay(
		apply: (executor: SqliteExecutor, catalog: ReadonlyMap<string, TableRecord>) => Promise<Replayed>,
		isDivergence: (error: unknown) => boolean,
	): Promise<void> {
		try {
			this.#assertReplayable();
		} catch (error) {
			return Promise.reject(error);
		}
		this.#open = undefined;
		const turn = this.#tail.then(() => this.#replay(apply, isDivergence));
		this.#tail = turn.then(NOTHING, NOTHING);
		return turn;
	}

	/** At its call and again at its turn: a claim or a divergence may come between the two. */
	#assertReplayable(): void {
		this.assertUsable();
		if (this.#diverged) throw invalid("args", "store: diverged; a batch can no longer apply");
		if (this.claims.held) throw invalid("args", "store: an owner holds claims; a batch would stale its memory");
	}

	async #replay(
		apply: (executor: SqliteExecutor, catalog: ReadonlyMap<string, TableRecord>) => Promise<Replayed>,
		isDivergence: (error: unknown) => boolean,
	): Promise<void> {
		this.#assertReplayable();
		// While it applies, no owner may claim (and read) what it is changing.
		const unlock = this.claims.lock();
		try {
			await this.#applyReplay(apply, isDivergence);
		} finally {
			unlock();
		}
	}

	async #applyReplay(
		apply: (executor: SqliteExecutor, catalog: ReadonlyMap<string, TableRecord>) => Promise<Replayed>,
		isDivergence: (error: unknown) => boolean,
	): Promise<void> {
		let thrown: unknown = NONE;
		let replayed: Replayed;
		try {
			replayed = await this.#db.transaction(async (executor) => {
				try {
					return await apply(executor, this.#catalog);
				} catch (error) {
					thrown = error;
					throw error;
				}
			});
		} catch (error) {
			if (error !== thrown) throw this.#fail(error);
			if (isDivergence(error)) this.#diverged = true;
			throw error;
		}
		this.#lastSeq = replayed.lastSeq;
		this.#committedNextId = replayed.nextId;
		this.#ids.raise(replayed.nextId - 1);
		for (const [name, record] of replayed.tables) this.#catalog.set(name, record);
		this.#committed();
	}

	/** Whether the store has an outbox, which a replayed batch writes too. */
	get recordsOutbox(): boolean {
		return this.#outbox !== undefined;
	}

	/** Throws `unavailable/storage_failed` once the store stopped, `released` once it closed. */
	assertUsable(): void {
		const state = this.#state;
		if (state.kind === "failed") throw storageFailed(state.error);
		if (state.kind === "closed")
			throw new ChordError({ code: "released", reason: "closed", message: "store: closed" });
	}

	/**
	 * Stops the store after `error` (once; its host is told once), latching it also when the store is closing; returns
	 * the error the caller rejects with.
	 */
	#fail(error: unknown): ChordError {
		this.#failure ??= { error };
		if (this.#state.kind === "open") {
			this.#state = { kind: "failed", error };
			this.#attachment?.failed(error);
		}
		return storageFailed(error);
	}
}

/** Records `seq`, the step's, as the store's last, and the allocator's value `nextId`. */
function writeMeta(step: Step, nextId: number): Promise<void> {
	return step.run(`UPDATE ${TABLES.meta} SET last_seq = ?, next_id = ? WHERE singleton = 1`, step.seq, nextId);
}

/**
 * `executor`, setting `calls.failed` when one of its calls throws, synchronously or by rejecting, with any value: a
 * check that throws then failed in the backend, not by its own decision.
 */
function watchCalls(executor: SqliteExecutor, calls: { failed: boolean }): SqliteExecutor {
	const watched = async <T>(call: () => Promise<T>): Promise<T> => {
		try {
			return await call();
		} catch (error) {
			calls.failed = true;
			throw error;
		}
	};
	return {
		exec: (sql) => watched(() => executor.exec(sql)),
		run: (sql, ...params) => watched(() => executor.run(sql, ...params)),
		runCounted: (sql, ...params) => watched(() => executor.runCounted(sql, ...params)),
		get: (sql, ...params) => watched(() => executor.get(sql, ...params)),
		all: (sql, ...params) => watched(() => executor.all(sql, ...params)),
	};
}

/** The `released` error of a commit its fence refused at the step's entry: its attempt ended. */
function discarded(): ChordError {
	return new ChordError({ code: "released", reason: "discarded", message: "store: the commit's attempt ended" });
}

/** The `unavailable/storage_failed` error of a stopped store, its backend error as the cause. */
function storageFailed(error: unknown): ChordError {
	return new ChordError(
		{ code: "unavailable", reason: "storage_failed", message: "store: storage failed" },
		{ cause: error },
	);
}
