// Shared live reads (decision "Identical live reads share one source"): the readers of one provider instance's named
// query with the same arguments and shape (a window of `first` rows, or a count) share one open read. One `OpenQuery`,
// one `Read` in the store's index, one skip test, one run, one decode and one value per write, which every subscriber
// takes; the last subscriber to leave closes it. An owner's own window (`self.query`) is a read of this kind nobody
// else subscribes to.

import { type Context, withoutAbortSignal } from "../context/index.ts";
import type { JsonValue } from "../json.ts";
import { DecodedRows } from "./decoded-rows.ts";
import type { LiveShape, LiveTarget } from "./live-query.ts";
import { OpenQuery, type OpenRead, type ReadSite } from "./open-query.ts";
import type { ReadRun, ReadSink } from "./read.ts";

/** What a shared read's subscribers take of a run: the value (rows as its shape presents them, or a count), or why not. */
export type ReadOutcome =
	| { readonly kind: "value"; readonly value: JsonValue }
	| { readonly kind: "failed"; readonly error: unknown };

/** Who takes a shared read's outcomes: called inside the batch of the run's adoption. */
export type ReadSubscriber = { adopted(read: SharedRead, outcome: ReadOutcome): void };

/**
 * Where a named query's target is shared: the open reads of its provider instance's query by key (shape and
 * arguments), and its arguments' canonical JSON, made once per target. The map is the query's own: it goes with the
 * provider's attempt.
 */
export type Sharing = { readonly reads: Map<string, SharedRead>; readonly args: string };

/**
 * The shared read of `target` in `shape` (`shapeKey` its text, made once per declaration): the open one of that key,
 * else a new one, whose first run starts now. `subscriber` takes its outcomes from now on, its current one at once
 * when it has one. Resolves with the read's first run once settled (`OpenRead.load`).
 */
export function subscribeShared(
	site: ReadSite,
	shape: LiveShape,
	shapeKey: string,
	target: LiveTarget,
	subscriber: ReadSubscriber,
	context: Context,
): { readonly read: SharedRead; readonly first: Promise<ReadRun | undefined> } {
	const sharing = target.sharing;
	if (sharing === undefined) {
		const read = new SharedRead(site, shape, target, undefined, context);
		return { read, first: read.subscribe(subscriber, context) };
	}
	const key = `${shapeKey} ${sharing.args}`;
	let read = sharing.reads.get(key);
	if (read === undefined) {
		// A shared read outlives the reader that made it: its loads and recompiles run without that attempt's signal.
		read = new SharedRead(site, shape, target, { reads: sharing.reads, key }, withoutAbortSignal(context));
		sharing.reads.set(key, read);
	}
	return { read, first: read.subscribe(subscriber, context) };
}

/** Where a shared read is filed: its query's map and its key there. */
type Home = { readonly reads: Map<string, SharedRead>; readonly key: string };

/** One open read of a target in a shape, with its subscribers; the sink of its runs. */
export class SharedRead implements ReadSink {
	readonly query: OpenQuery;
	readonly read: OpenRead;
	readonly #target: LiveTarget;
	readonly #shape: LiveShape;
	readonly #home: Home | undefined;
	readonly #rows = new DecodedRows("values");
	readonly #subscribers = new Set<ReadSubscriber>();
	/** Its first run, started when it was made. */
	readonly #first: Promise<ReadRun | undefined>;
	/** What its last adopted run gave; `undefined` before its first. */
	#outcome: ReadOutcome | undefined;

	constructor(site: ReadSite, shape: LiveShape, target: LiveTarget, home: Home | undefined, context: Context) {
		this.#target = target;
		this.#shape = shape;
		this.#home = home;
		// A binding changed: its one read runs again (a failure is a failed run handed to it; nothing awaits the run).
		this.query = new OpenQuery(site, target.spec, shape.kind, () => void this.read.load(), context);
		// A shape of rows is what the read reads (its range), a count is one: no read kind made per read.
		this.read = this.query.read(shape, this);
		this.#first = this.read.load();
	}

	/**
	 * `subscriber` takes its outcomes from now on, its current one at once (in a batch) when it has one. Resolves with
	 * its first run once settled.
	 */
	subscribe(subscriber: ReadSubscriber, context: Context): Promise<ReadRun | undefined> {
		this.#subscribers.add(subscriber);
		const outcome = this.#outcome;
		if (outcome !== undefined) this.query.site.batch.within(() => subscriber.adopted(this, outcome), context);
		return this.#first;
	}

	/** `subscriber` takes nothing more; the last one to leave closes the read. */
	unsubscribe(subscriber: ReadSubscriber): void {
		const subscribers = this.#subscribers;
		if (!subscribers.delete(subscriber) || subscribers.size > 0) return;
		this.query.close();
		const home = this.#home;
		if (home !== undefined && home.reads.get(home.key) === this) home.reads.delete(home.key);
	}

	/** A run, inside a batch: its outcome made once, handed to every subscriber. */
	adopt(run: ReadRun): void {
		const outcome = this.#outcomeOf(run);
		this.#outcome = outcome;
		for (const subscriber of this.#subscribers) subscriber.adopted(this, outcome);
	}

	/** The value of a run, or its failure; a row the code cannot read fails it. */
	#outcomeOf(run: ReadRun): ReadOutcome {
		if (run.kind === "failed") return { kind: "failed", error: run.error };
		if (run.kind === "count") return { kind: "value", value: run.count };
		const shape = this.#shape;
		// A read of rows has a shape of rows.
		const present = (shape as Extract<LiveShape, { readonly kind: "rows" }>).present;
		const { result } = run;
		try {
			const rows = this.#rows.decode(result.rows, this.#target, this.query.context, result.ids);
			return { kind: "value", value: present(rows, result.more) };
		} catch (error) {
			return { kind: "failed", error };
		}
	}
}
