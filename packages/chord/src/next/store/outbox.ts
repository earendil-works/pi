// The outbox (slice 6a §2; decisions "The outbox is optional, internal and versioned", small items 3-4): the store's
// commits as the sync layer reads them, one `{ seq, writes }` per commit from its floor on, in the current format.

import type { Context } from "../../context/index.ts";
import { ChordError } from "../data/index.ts";
import { invalid } from "../data/internal.ts";
import { TABLES } from "./schema.ts";
import type { ChordStore } from "./store.ts";
import type { StoreWrite } from "./writes.ts";

/** The write vocabulary's version an outbox commit is stored in; a newer one is refused, data intact. */
export const OUTBOX_FORMAT = 1;

/** One commit as the outbox gives it: its seq, the allocator's value it persisted (D3) and its writes in applied order. */
export type OutboxCommit = { readonly seq: number; readonly nextId: number; readonly writes: readonly StoreWrite[] };

const NOTHING = (): void => {};

/** A store's outbox: its commits after the floor (the seq it was turned on at, advanced by `trim`). */
export class Outbox {
	readonly #store: ChordStore;
	#floor: number;
	/**
	 * The outbox's reads and trims, one at a time: a read checks the floor and reads with no trim running (a trim's
	 * commit may have deleted rows before its floor is set), a trim waits for the reads in flight.
	 */
	#queue: Promise<void> = Promise.resolve();

	constructor(store: ChordStore, floor: number) {
		this.#store = store;
		this.#floor = floor;
	}

	/** The seq the outbox starts after: `read` takes any `afterSeq` from it to `lastSeq`. */
	get floor(): number {
		return this.#floor;
	}

	/** Up to `limit` commits after `afterSeq`, in seq order; `afterSeq` outside floor..lastSeq is `invalid/args`. */
	async read(afterSeq: number, limit: number, context: Context): Promise<OutboxCommit[]> {
		if (!Number.isSafeInteger(afterSeq)) throw invalid("args", `outbox: read after ${afterSeq}, not an integer`);
		if (!Number.isSafeInteger(limit) || limit < 1) throw invalid("args", "outbox: limit is a positive integer");
		return this.#queued(() => this.#read(afterSeq, limit, context));
	}

	/**
	 * Drops the commits through `throughSeq` and advances the floor; idempotent; beyond `lastSeq` is `invalid/args`.
	 * Trims run one at a time, so the stored floor only rises and equals the one in memory.
	 */
	trim(throughSeq: number, context: Context): Promise<void> {
		try {
			context.abortSignal?.throwIfAborted();
			if (!Number.isSafeInteger(throughSeq) || throughSeq > this.#store.lastSeq) {
				throw invalid("args", `outbox: trim through ${throughSeq}, beyond ${this.#store.lastSeq}`);
			}
		} catch (error) {
			return Promise.reject(error);
		}
		return this.#queued(() => this.#trim(throughSeq));
	}

	/** Runs `operation` once the outbox operations before it settled. */
	#queued<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(operation);
		this.#queue = run.then(NOTHING, NOTHING);
		return run;
	}

	/** `read`, its turn come: the floor as no trim moves it. */
	async #read(afterSeq: number, limit: number, context: Context): Promise<OutboxCommit[]> {
		if (afterSeq < this.#floor || afterSeq > this.#store.lastSeq) {
			throw invalid("args", `outbox: read after ${afterSeq}, outside ${this.#floor}..${this.#store.lastSeq}`);
		}
		const rows = await this.#store.read(
			(executor) =>
				executor.all<{
					readonly seq: number;
					readonly format: number;
					readonly next_id: number;
					readonly writes: string;
				}>(
					`SELECT seq, format, next_id, writes FROM ${TABLES.outbox} WHERE seq > ? ORDER BY seq LIMIT ?`,
					afterSeq,
					limit,
				),
			context,
		);
		return rows.map(({ seq, format, next_id, writes }) => {
			if (format !== OUTBOX_FORMAT) {
				const message = `outbox: commit ${seq} is in format ${format}, newer than ${OUTBOX_FORMAT}`;
				throw new ChordError({ code: "unavailable", message });
			}
			return { seq, nextId: next_id, writes: JSON.parse(writes) as StoreWrite[] };
		});
	}

	async #trim(throughSeq: number): Promise<void> {
		if (throughSeq <= this.#floor) return;
		await this.#store.maintain(async (executor) => {
			await executor.run(`DELETE FROM ${TABLES.outbox} WHERE seq <= ?`, throughSeq);
			await executor.run(`UPDATE ${TABLES.meta} SET outbox_floor = ? WHERE singleton = 1`, throughSeq);
		});
		this.#floor = throughSeq;
	}
}
