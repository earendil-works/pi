// The store (slice 6a §2, §3, slice 6b §1): opened over a backend, one commit queue that serializes only the commit step
// (the seal fence's admission check, `BEGIN`, the writes in their order, the outbox commit, `lastSeq` and the
// allocator's value, `COMMIT`, then the owner's adoption), the id allocator, the claims of its tables and documents,
// reads guarded as Durable's `GuardedStorage` guards them, Durable's Storage semantics for a refused step (D4), and the
// stop after an unknown outcome.

import { awaitWithContext, type Context } from "../../context/index.ts";
import type { SqliteDatabase, SqliteExecutor } from "../../sqlite/index.ts";
import { ChordError } from "../data/index.ts";
import { invalid } from "../data/internal.ts";
import type { Batch } from "../state/internal.ts";
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
	 * The store's state after its `lastSeq` as archive parts (slice 6a §13), holding the commit queue from the first
	 * `next()` until the iteration ends, throws, is closed or `context` aborts.
	 */
	export(context: Context): AsyncIterableIterator<ArchivePart>;
	/**
	 * Closes the store: waits for a running commit step, rejects queued commits and reads `released`, closes the
	 * backend. Idempotent, also after `storage_failed`; `context` ends only this caller's wait (the close goes on).
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
	/** After `COMMIT`: adopts the commit, `ids` being its created documents' ids in the order of their writes. */
	adopt(seq: number, ids: readonly number[]): void;
};

/** What the open host gives the store: its `storage_failed` listener and its batch, in which adapters adopt (§1.3). */
export type Attachment = {
	readonly failed: (error: unknown) => void;
	readonly batch: Batch;
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
	/** Set once a batch's recorded count did not reproduce (S17): no batch applies any more. */
	#diverged = false;
	/** The commit queue's tail: each step starts after the one before it settled. */
	#tail: Promise<void> = Promise.resolve();
	/** Reads and maintenance writes underway, which `close` waits for. */
	#underway = 0;
	/** Resolves `close`'s wait once no read is underway. */
	#drained: (() => void) | undefined;
	/** The open host's listener for `storage_failed` (told once) and batch; one host per store (rule 7). */
	#attachment: Attachment | undefined;
	#closing: Promise<void> | undefined;
	/** The recorded tables, by SQL name; changed only after a step's `COMMIT`. */
	readonly #catalog: Map<string, TableRecord>;
	/** The ends of the exports holding the queue or waiting for it, which closing the store calls. */
	readonly #held = new Set<() => void>();

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

	/** The open host's batch, in which an adapter adopts its commits; `undefined` without a host. */
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
	 * Commits `writes` as one seq when the commit queue reaches it: `fence.admit()` at the step's entry, the writes in
	 * their order (retirements, creations, the rest), the outbox commit, `lastSeq` and the allocator's value, `COMMIT`,
	 * then `fence.adopt` before the next step starts. Resolves with the seq. A refused admission rejects `released`. A
	 * step the backend rolled back after the step's own code threw (a refusal, D4) rejects with that error unchanged and
	 * the store goes on; any other failure (`BEGIN`, `COMMIT`, `ROLLBACK`, a throwing `adopt`) is an unknown outcome
	 * that stops the store (`storage_failed`). `context` counts the step (no abort once queued).
	 */
	commit(writes: readonly StagedWrite[], fence: CommitFence, context: Context): Promise<number> {
		try {
			this.assertUsable();
		} catch (error) {
			return Promise.reject(error);
		}
		const step = this.#tail.then(() => this.#step(writes, fence, context));
		this.#tail = step.then(NOTHING, NOTHING);
		return step;
	}

	/**
	 * An adapter's commit (§1.3): `commit` admitting every write, its adoption run in the attached host's batch
	 * (`batch.within`: it joins a running batch or opens one), plainly without a host. Durable's `adopt` publishes inside
	 * it, so Chord sources over Durable's views are marked in the step.
	 */
	commitInBatch(writes: readonly StagedWrite[], adopt: (seq: number) => void, context: Context): Promise<number> {
		const fence: CommitFence = {
			admit: () => true,
			adopt: (seq) => {
				const batch = this.#attachment?.batch;
				if (batch === undefined) adopt(seq);
				else batch.within(() => adopt(seq), context);
			},
		};
		return this.commit(writes, fence, context);
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
			this.assertUsable();
			const signal = context.abortSignal;
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

	async #step(writes: readonly StagedWrite[], fence: CommitFence, context: Context): Promise<number> {
		this.assertUsable();
		if (!fence.admit()) {
			throw new ChordError({ code: "released", reason: "discarded", message: "store: the commit's attempt ended" });
		}
		if (writes.length === 0) {
			// An empty commit takes no seq; a throwing `adopt` stops the store as for any commit.
			try {
				fence.adopt(this.#lastSeq, []);
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
					return await this.#write(executor, seq, writes);
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
		const metrics = context.telemetry.metrics;
		metrics?.counter("chord.store.commits").add(1);
		metrics?.counter("chord.store.statements").add(step.statements);
		try {
			fence.adopt(seq, step.created);
		} catch (error) {
			throw this.#fail(error);
		}
		return seq;
	}

	/**
	 * The step's writes inside its backend transaction: each staged write in its phase, the catalog, the outbox commit,
	 * the metadata. The allocator's value is taken once, after the writes applied (mints meanwhile only raise it).
	 */
	async #write(
		executor: SqliteExecutor,
		seq: number,
		writes: readonly StagedWrite[],
	): Promise<{ readonly step: Step; readonly nextId: number }> {
		const step = new Step(executor, seq, this.#ids, this.#catalog);
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
		await step.run(`UPDATE ${TABLES.meta} SET last_seq = ?, next_id = ? WHERE singleton = 1`, seq, nextId);
		return { step, nextId };
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

	/** Stops the store after `error` (once; its host is told once); returns the error the caller rejects with. */
	#fail(error: unknown): ChordError {
		if (this.#state.kind === "open") {
			this.#state = { kind: "failed", error };
			this.#attachment?.failed(error);
		}
		return storageFailed(error);
	}
}

/** The `unavailable/storage_failed` error of a stopped store, its backend error as the cause. */
function storageFailed(error: unknown): ChordError {
	return new ChordError(
		{ code: "unavailable", reason: "storage_failed", message: "store: storage failed" },
		{ cause: error },
	);
}
