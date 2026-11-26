// Live queries (decision "Live queries over an object's own tables"; slice 14 §3): the rows of a query as a JSON
// watchable, kept current by the store's reads. `self.query(table, q, limit)` is the owner's own unnamed window (its
// value the rows); `self.liveQuery(namedQuery, args, { first })` reads a named query (its value `{ rows, more }`).
// Both are this source over a shared read (`shared-read.ts`: identical reads of a named query are one); a commit's
// run is published in that commit's batch as the diff from the previous rows (W1).

import type { Context } from "../context/index.ts";
import { invalid } from "../data/internal.ts";
import { type FramedOwner, FramedSource } from "../state/internal.ts";
import type { ReadSite } from "./open-query.ts";
import type { Query } from "./query.ts";
import {
	type LiveShape,
	type LiveTarget,
	type ReadOutcome,
	type ReadSubscriber,
	type SharedRead,
	sharedRead,
} from "./shared-read.ts";
import type { TableDefinition } from "./table.ts";

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
export class LiveQuery extends FramedSource implements ReadSubscriber {
	readonly #site: ReadSite;
	readonly #shape: LiveShape;
	/** The shared read its value is of, and the one that replaces it once it has an outcome: never the same one. */
	#current: SharedRead | undefined;
	#next: SharedRead | undefined;

	constructor(site: ReadSite, owner: FramedOwner, shape: LiveShape) {
		super(site.batch, owner);
		this.#site = site;
		this.#shape = shape;
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
	 * once that read has an outcome, or its first run ended without one (a table it reads is held).
	 */
	read(target: LiveTarget, context: Context): Promise<void> {
		if (this.detached) return Promise.resolve();
		const read = sharedRead(this.#site, this.#shape, target, context);
		const replaced = this.#next;
		// The read its value is of (arguments that changed and changed back): nothing replaces it.
		this.#next = read === this.#current ? undefined : read;
		if (replaced !== read) replaced?.unsubscribe(this);
		return read.subscribe(this, context);
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
		this.#current?.unsubscribe(this);
		this.#next?.unsubscribe(this);
		this.#current = undefined;
		this.#next = undefined;
	}

	/**
	 * Takes an outcome of one of its shared reads, inside a batch. The first outcome of the read that replaces the
	 * current one makes it the current one. A failure makes the query a failed member.
	 */
	adopted(read: SharedRead, outcome: ReadOutcome): void {
		if (this.detached) return;
		if (read === this.#next) {
			this.#current?.unsubscribe(this);
			this.#current = read;
			this.#next = undefined;
		} else if (read !== this.#current) return;
		if (outcome.kind === "failed") this.failWith(outcome.error);
		else this.set(outcome.value);
	}
}
