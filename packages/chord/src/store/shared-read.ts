// Shared live reads (decision "Identical live reads share one source"): the readers of one provider instance's named
// query with the same arguments and shape (a window of `first` rows, or a count) share one open read. One `OpenQuery`,
// one `Read` in the store's index, one skip test, one run, one decode and one value per write, which every subscriber
// takes; the last subscriber to leave closes it. An owner's own window (`self.query`) is a read of this kind nobody
// else subscribes to.

import { BACKGROUND_CONTEXT, type Context, withAbortSignal, withTelemetry } from "../context/index.ts";
import type { JsonValue } from "../json.ts";
import { SmallSet } from "../small-set.ts";
import { countingOnly } from "../telemetry.ts";
import { DecodedRows } from "./decoded-rows.ts";
import { OpenQuery, type OpenRead, type QueryOwner, type QuerySpec, type ReadSite } from "./open-query.ts";
import type { ReadRun, ReadSink } from "./read.ts";
import type { Range, StoredRead } from "./read-plan.ts";

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

/** Where a named query's target is shared: its provider instance's shared reads, and its arguments' canonical JSON. */
export type Sharing = { readonly shared: SharedReads; readonly args: string };

/** What a shared read's subscribers take of a run: the value (rows as its shape presents them, or a count), or why not. */
export type ReadOutcome =
	| { readonly kind: "value"; readonly value: JsonValue }
	| { readonly kind: "failed"; readonly error: unknown };

/** Who takes a shared read's outcomes, told which read's: called inside the batch of the run's adoption. */
export type ReadSubscriber = { adopted(read: SharedRead, outcome: ReadOutcome): void };

/**
 * The shared read of `target` in `shape`: the open one of its key (the shape and the arguments), else a new one,
 * whose first run starts now. A target nobody shares (the owner's own window) gets a read of its own, on its reader's
 * site and context.
 */
export function sharedRead(site: ReadSite, shape: LiveShape, target: LiveTarget, context: Context): SharedRead {
	const sharing = target.sharing;
	if (sharing === undefined) return new SharedRead(site, context, shape, target, "");
	// The key ignores the shape's `present` and the range's other bounds: one `present` serves every named query, and a
	// live query's range is its limit.
	const key = `${shape.kind === "rows" ? `rows ${shape.range.limit}` : "count"} ${sharing.args}`;
	return sharing.shared.of(key, site, shape, target, context);
}

/**
 * The shared reads of one provider instance's named query, by key; kept by the query (`OwnQuery`), so they go with the
 * provider's attempt. Their site and context are its own, made by the first: a shared read outlives the reader that
 * made it, so it keeps nothing of that reader (its site wakes its attempt, its context carries its object, span and
 * signal), only the store, the batch and the adapter's metrics.
 */
export class SharedReads {
	readonly #reads = new Map<string, SharedRead>();
	#site: ReadSite | undefined;
	#context: Context | undefined;

	/** The open read of `key`, else a new one of `target` in `shape`. */
	of(key: string, site: ReadSite, shape: LiveShape, target: LiveTarget, context: Context): SharedRead {
		const open = this.#reads.get(key);
		if (open !== undefined) return open;
		this.#site ??= { store: site.store, batch: site.batch };
		const metrics = context.telemetry.metrics;
		this.#context ??=
			metrics === undefined ? BACKGROUND_CONTEXT : withTelemetry(countingOnly(metrics), BACKGROUND_CONTEXT);
		const read = new SharedRead(this.#site, this.#context, shape, target, key);
		this.#reads.set(key, read);
		return read;
	}

	/** The read of `key` closed. */
	closed(key: string): void {
		this.#reads.delete(key);
	}
}

/** What a subscriber awaits of a read that has an outcome, or whose first run ended: nothing. */
const SETTLED: Promise<void> = Promise.resolve();

/** One open read of a target in a shape, with its subscribers; the sink of its runs. */
export class SharedRead implements ReadSink, QueryOwner {
	readonly query: OpenQuery;
	readonly #read: OpenRead;
	readonly #target: LiveTarget;
	readonly #shape: LiveShape;
	/** Its key among its target's shared reads; unused for a target nobody shares. */
	readonly #key: string;
	/** A count's read has no rows to decode. */
	readonly #rows: DecodedRows | undefined;
	readonly #subscribers = new SmallSet<ReadSubscriber>();
	/**
	 * What its subscribers await until it has an outcome or its first run ended (a table it reads held), whichever
	 * comes first: one promise for all of them, so a commit's run overtaking the first run lets every waiting one go
	 * on. It carries nothing (not the run, whose stored rows nobody keeps).
	 */
	#waiting: PromiseWithResolvers<void> | undefined = Promise.withResolvers<void>();
	/** What its last adopted run gave; `undefined` before its first. */
	#outcome: ReadOutcome | undefined;
	/** The cancellation of the load running now, if one is: aborted when the read closes. */
	#loading: AbortController | undefined;

	constructor(site: ReadSite, context: Context, shape: LiveShape, target: LiveTarget, key: string) {
		this.#target = target;
		this.#shape = shape;
		this.#key = key;
		this.#rows = shape.kind === "rows" ? new DecodedRows("values") : undefined;
		this.query = new OpenQuery(site, target.spec, shape.kind, this, context);
		// A shape of rows is what the read reads (its range), a count is one: no read kind made per read.
		this.#read = this.query.read(shape, this);
		void this.#load().then(() => this.#settle());
	}

	/**
	 * `subscriber` takes its outcomes from now on, its current one at once (in a batch) when it has one; one that
	 * subscribed already takes nothing new. Resolves once the read has an outcome or its first run ended.
	 */
	subscribe(subscriber: ReadSubscriber, context: Context): Promise<void> {
		const subscribers = this.#subscribers;
		const outcome = this.#outcome;
		const before = subscribers.size;
		subscribers.add(subscriber);
		if (outcome !== undefined && subscribers.size > before) {
			this.query.site.batch.within(() => subscriber.adopted(this, outcome), context);
		}
		return this.#waiting?.promise ?? SETTLED;
	}

	/** `subscriber` takes nothing more; the last one to leave closes the read. */
	unsubscribe(subscriber: ReadSubscriber): void {
		const subscribers = this.#subscribers;
		if (!subscribers.delete(subscriber) || subscribers.size > 0) return;
		this.query.close();
		this.#target.sharing?.shared.closed(this.#key);
	}

	/** A binding changed: its one read runs again (a failure is a failed run handed to it; nothing awaits the run). */
	rebound(): void {
		void this.#load();
	}

	/** Its query closed (its last reader left, its provider retired): the load running now is aborted. */
	closed(): void {
		this.#loading?.abort();
	}

	/**
	 * A run, inside a batch: its outcome made once, handed to every subscriber. A run adopted after the last one left
	 * (a commit's step ran it before) is decoded for nobody; one adopted before the first came (a query that does not
	 * compile fails at once) is kept for it.
	 */
	adopt(run: ReadRun): void {
		const subscribers = this.#subscribers;
		if (subscribers.size === 0 && this.query.closed) return;
		const outcome = this.#outcomeOf(run);
		this.#outcome = outcome;
		subscribers.forEach((subscriber) => {
			subscriber.adopted(this, outcome);
		});
		this.#settle();
	}

	/** Its subscribers waiting for an outcome or the first run's end go on. */
	#settle(): void {
		this.#waiting?.resolve();
		this.#waiting = undefined;
	}

	/**
	 * One run outside the commit queue. Each load of a shared read has its own signal: a load overtaken by the next one
	 * (a binding changed: its run is dropped) and the one running when the read closes (its last reader left, its
	 * provider retired) are aborted, so a late failure of theirs is no failure of the store.
	 */
	async #load(): Promise<void> {
		const { context } = this.query;
		if (this.#target.sharing === undefined) {
			await this.#read.load(context);
			return;
		}
		const cancel = new AbortController();
		// The load still running was overtaken: it ends now, not at the close.
		this.#loading?.abort();
		this.#loading = cancel;
		try {
			await this.#read.load(withAbortSignal(cancel.signal, context));
		} finally {
			if (this.#loading === cancel) this.#loading = undefined;
		}
	}

	/** The value of a run, or its failure; a row the code cannot read fails it. */
	#outcomeOf(run: ReadRun): ReadOutcome {
		if (run.kind === "failed") return { kind: "failed", error: run.error };
		if (run.kind === "count") return { kind: "value", value: run.count };
		// A read of rows has a shape of rows, and rows to decode.
		const present = (this.#shape as Extract<LiveShape, { readonly kind: "rows" }>).present;
		const { result } = run;
		try {
			const rows = this.#rows!.decode(result.rows, this.#target, this.query.context, result.ids);
			return { kind: "value", value: present(rows, result.more) };
		} catch (error) {
			return { kind: "failed", error };
		}
	}
}
