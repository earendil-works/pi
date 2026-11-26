// Live queries (decision "Live queries over an object's own tables"; slice 14 §3): the rows of a query as a JSON
// watchable, kept current by the store's reads. `self.query(table, q, limit)` is the owner's own unnamed window (its
// value the rows); `self.liveQuery(namedQuery, args, { first })` reads a named query (its value `{ rows, more }`).
// Both are this source over a shared read (`shared-read.ts`: identical reads of a named query are one); a commit's
// run is published in that commit's batch as the diff from the previous rows (W1).

import type { Context } from "../context/index.ts";
import { invalid } from "../data/internal.ts";
import type { JsonValue } from "../json.ts";
import { type FramedOwner, FramedSource } from "../state/internal.ts";
import type { QuerySpec, ReadSite } from "./open-query.ts";
import type { Query } from "./query.ts";
import type { ReadRun } from "./read.ts";
import type { Range, StoredRead } from "./read-plan.ts";
import {
	type ReadOutcome,
	type ReadSubscriber,
	type SharedRead,
	type Sharing,
	subscribeShared,
} from "./shared-read.ts";
import type { TableDefinition } from "./table.ts";

/**
 * What a live source reads: a query to keep open, and how a stored row of it becomes the value's row (decoded,
 * projected, mapped); a row the code cannot read throws.
 */
export type LiveTarget = {
	readonly spec: QuerySpec;
	/** Where its reads are shared with other readers (a named query's); `undefined` for the owner's own window. */
	readonly sharing: Sharing | undefined;
	decode(stored: StoredRead, context: Context): JsonValue;
};

/** What a live query reads and shows: the rows of `range` (as they are, or as `{ rows, more }`), or a count. */
export type LiveShape =
	| { readonly kind: "rows"; readonly range: Range; present(rows: JsonValue[], more: boolean): JsonValue }
	| { readonly kind: "count" };

/**
 * Refuses what the types cannot (plugin code is bundled without type checks; declaration policy): a query of another
 * table than `table`, and a `limit` that is no positive integer (a live query must be bounded: one run reads at most
 * `limit` rows).
 */
export function checkLiveQuery(table: TableDefinition, q: Query, limit: unknown, label: string): void {
	if (q.table !== table) {
		throw invalid("args", `${label}: self.query: a query of table "${q.table.name}" over "${table.name}"`);
	}
	if (!Number.isSafeInteger(limit) || (limit as number) < 1) {
		throw invalid("args", `${label}: self.query: a limit is required, a positive integer`);
	}
}

/**
 * A live query as a JSON source (a state member, a derive source, an `on` source): the rows of one range of a query,
 * or its count, as a shared read gives them (`shared-read.ts`). `read` gives it the query; a later `read` (arguments
 * that follow a value, a provider's successor) shows the previous value until the new read has an outcome, then
 * switches in one frame.
 */
export class LiveQuery extends FramedSource {
	readonly #site: ReadSite;
	readonly #shape: LiveShape;
	/** The shape as the key of a shared read: a live query's range is its limit. */
	readonly #shapeKey: string;
	/** The subscription its value is of, and the one that replaces it once it has an outcome. */
	#current: Reading | undefined;
	#next: Reading | undefined;

	constructor(site: ReadSite, owner: FramedOwner, shape: LiveShape) {
		super(site.batch, owner);
		this.#site = site;
		this.#shape = shape;
		this.#shapeKey = shape.kind === "rows" ? `rows ${shape.range.limit}` : "count";
	}

	/**
	 * The first run of the owner's own window, before its object goes live (activation, after its tables are
	 * prepared): a failure throws and fails the activation, which reports it.
	 */
	async load(target: LiveTarget, context: Context): Promise<void> {
		this.quiet();
		await this.read(target, context);
		const failure = this.failure;
		if (failure !== undefined) throw failure.error;
	}

	/**
	 * Reads `target` from now on (its shape's range of it, or its count), through the shared read of its key. Resolves
	 * with that read's first run once settled (`undefined`: a commit's run came first, a table it reads is held, or the
	 * read was closed meanwhile).
	 */
	read(target: LiveTarget, context: Context): Promise<ReadRun | undefined> {
		if (this.detached) return Promise.resolve(undefined);
		this.#next?.close();
		const reading = new Reading(this);
		this.#next = reading;
		return reading.open(this.#site, this.#shape, this.#shapeKey, target, context);
	}

	/**
	 * What it should read cannot be read (its arguments threw, its provider refused them): a failed member, as a
	 * failed run makes it. Its subscriptions end: neither the read of the previous arguments nor a pending one may
	 * publish or heal the failure; the next `read` does.
	 */
	fail(error: unknown, context: Context): void {
		if (this.detached) return;
		this.#close();
		this.batch.within(() => this.failWith(error), context);
	}

	/** Its attempt ended: its subscriptions end, reads throw `error` (the object's), its watches end `ended`. */
	detach(error: Error): void {
		this.#close();
		this.end(error);
	}

	#close(): void {
		this.#current?.close();
		this.#next?.close();
		this.#current = undefined;
		this.#next = undefined;
	}

	/**
	 * Takes an outcome of one of its subscriptions, inside a batch (called by the reading). The first outcome of a new
	 * subscription makes it the current one. A failure makes the query a failed member.
	 */
	adopted(reading: Reading, outcome: ReadOutcome): void {
		if (this.detached) return;
		if (reading === this.#next) {
			this.#current?.close();
			this.#current = reading;
			this.#next = undefined;
		} else if (reading !== this.#current) return;
		if (outcome.kind === "failed") this.failWith(outcome.error);
		else this.set(outcome.value);
	}
}

/**
 * One of a live query's subscriptions to a shared read. A class: the live query tells its subscriptions apart (the
 * pending one and the current one may be of one shared read).
 */
class Reading implements ReadSubscriber {
	readonly #live: LiveQuery;
	#read: SharedRead | undefined;

	constructor(live: LiveQuery) {
		this.#live = live;
	}

	/** Subscribes to the shared read of `target`; resolves with its first run once settled. */
	open(
		site: ReadSite,
		shape: LiveShape,
		shapeKey: string,
		target: LiveTarget,
		context: Context,
	): Promise<ReadRun | undefined> {
		const { read, first } = subscribeShared(site, shape, shapeKey, target, this, context);
		this.#read = read;
		return first;
	}

	close(): void {
		this.#read?.unsubscribe(this);
		this.#read = undefined;
	}

	adopted(_read: SharedRead, outcome: ReadOutcome): void {
		this.#live.adopted(this, outcome);
	}
}
